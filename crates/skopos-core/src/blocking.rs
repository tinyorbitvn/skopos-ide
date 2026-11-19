//! Work that blocks a thread (files, parsing a big document) must not run on a Tokio
//! worker, where it would hold up every other request the worker serves (perf spec §9).

use crate::error::{CoreResult, ErrorCode, IpcError};

/// Runs `work` on a blocking thread and gives back its result as it is. A panic in `work`
/// or a runtime that is shutting down comes back as `Internal`.
pub async fn blocking<T, F>(work: F) -> CoreResult<T>
where
    F: FnOnce() -> CoreResult<T> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result,
        Err(error) => Err(IpcError::new(
            ErrorCode::Internal,
            format!("a background task failed: {error}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;
    use crate::error::{ErrorCode, IpcError};

    #[tokio::test]
    async fn the_result_comes_back_unchanged() {
        assert_eq!(blocking(|| Ok(7)).await.unwrap(), 7);
        let error = blocking(|| -> CoreResult<()> {
            Err(IpcError::new(ErrorCode::Conflict, "taken").with_details("d"))
        })
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        assert_eq!(error.message, "taken");
        assert_eq!(error.details.as_deref(), Some("d"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn the_runtime_keeps_running_while_the_work_blocks() {
        // One thread runs every task. If the work ran on it, the ticker could not run.
        let ticks = Arc::new(AtomicUsize::new(0));
        let ticker = tokio::spawn({
            let ticks = Arc::clone(&ticks);
            async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    ticks.fetch_add(1, Ordering::SeqCst);
                }
            }
        });

        blocking(|| {
            std::thread::sleep(Duration::from_millis(300));
            Ok(())
        })
        .await
        .unwrap();

        ticker.abort();
        assert!(
            ticks.load(Ordering::SeqCst) >= 5,
            "the runtime was blocked: {} ticks",
            ticks.load(Ordering::SeqCst)
        );
    }

    #[tokio::test]
    async fn a_panic_is_an_internal_error() {
        let error = blocking(|| -> CoreResult<()> { panic!("boom") })
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Internal);
    }
}
