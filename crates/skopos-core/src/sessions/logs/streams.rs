//! Runs a session's container streams, at most `cap` at a time. The rest wait in a FIFO
//! queue and start as streams end or Pods go, and the session says so with `Limited`.

use std::collections::VecDeque;

use tokio::sync::mpsc;
use tokio::task::JoinSet;

use super::follow::{stream_container, ContainerEnd, StreamContext, StreamTarget};
use super::{LogMarker, StreamItem};

struct Waiting {
    context: StreamContext,
    target: StreamTarget,
}

pub(super) struct StreamSet {
    items: mpsc::Sender<StreamItem>,
    /// What the `Limited` marker names as its `pod`: the workload or the Pod of the session.
    label: String,
    cap: usize,
    running: JoinSet<(StreamTarget, ContainerEnd)>,
    waiting: VecDeque<Waiting>,
    /// `(streaming, total)` of the last `Limited` marker, until a final one clears it.
    announced: Option<(u32, u32)>,
}

impl StreamSet {
    pub(super) fn new(items: mpsc::Sender<StreamItem>, label: String, cap: usize) -> Self {
        Self {
            items,
            label,
            cap: cap.max(1),
            running: JoinSet::new(),
            waiting: VecDeque::new(),
            announced: None,
        }
    }

    /// Starts the stream now when there is room, else queues it. Call `announce` after a
    /// batch of these.
    pub(super) fn add(&mut self, context: StreamContext, target: StreamTarget) {
        self.waiting.push_back(Waiting { context, target });
        self.fill();
    }

    /// Drops the queued targets of a Pod that is gone. Its running streams end on their own,
    /// because the caller cancelled their token, and `next` then starts the next in line.
    pub(super) fn forget_waiting(&mut self, pod: &str) {
        self.waiting.retain(|waiting| waiting.target.pod != pod);
    }

    fn fill(&mut self) {
        while self.running.len() < self.cap {
            let Some(Waiting { context, target }) = self.waiting.pop_front() else {
                break;
            };
            // A Pod removed while it waited, or a session that stopped.
            if context.token.is_cancelled() {
                continue;
            }
            self.running.spawn(async move {
                let end = stream_container(context, target.clone()).await;
                (target, end)
            });
        }
    }

    /// The next stream to end, with its target, after starting the one that takes its place.
    /// Cancel safe, so it can sit in a `select!`. `None` when nothing runs or waits.
    pub(super) async fn next(&mut self) -> Option<(StreamTarget, ContainerEnd)> {
        loop {
            let joined = self.running.join_next().await?;
            self.fill();
            // A stream that panicked has nothing to report.
            if let Ok(done) = joined {
                return Some(done);
            }
        }
    }

    /// Sends a `Limited` marker when the queue changed, and a last one when it emptied.
    pub(super) async fn announce(&mut self) {
        let streaming = u32::try_from(self.running.len()).unwrap_or(u32::MAX);
        let total = streaming.saturating_add(u32::try_from(self.waiting.len()).unwrap_or(u32::MAX));
        let now = if self.waiting.is_empty() {
            // Nothing waits: say so once if the session was limited before.
            if self.announced.take().is_none() {
                return;
            }
            (total, total)
        } else {
            if self.announced == Some((streaming, total)) {
                return;
            }
            self.announced = Some((streaming, total));
            (streaming, total)
        };
        let item = StreamItem::Marker {
            pod: self.label.clone(),
            container: None,
            marker: LogMarker::Limited {
                streaming: now.0,
                total: now.1,
            },
            message: None,
        };
        // Only fails once the batcher has gone, and that stops the session anyway.
        let _ = self.items.send(item).await;
    }
}
