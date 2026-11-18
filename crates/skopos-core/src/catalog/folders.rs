//! The folder tree the user sorts the catalog into (spec P26 to P28), kept in
//! `catalog-folders.json`. Folders nest; a cluster sits in at most one folder, and a
//! cluster without a placement is at the top level.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::app_core::{AppCore, CoreEvent};
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;

const MAX_NAME_CHARS: usize = 64;
const ID_PREFIX: &str = "folder-";
const TOP_LEVEL: &str = "Top level";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogFolder {
    pub id: String,
    pub name: String,
    /// The folder this one sits in; `None` at the top level.
    pub parent: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct CatalogFolders {
    pub folders: Vec<CatalogFolder>,
    /// Cluster id to folder id.
    pub placements: BTreeMap<ClusterId, String>,
}

fn invalid(message: impl Into<String>) -> IpcError {
    IpcError::new(ErrorCode::InvalidInput, message)
}

fn gone() -> IpcError {
    IpcError::new(ErrorCode::NotFound, "That folder no longer exists.")
}

/// The trimmed name, or the P27 error for an empty or long one.
fn clean_name(name: &str) -> CoreResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(invalid("A folder needs a name."));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(invalid("A folder name has at most 64 characters."));
    }
    Ok(name.to_owned())
}

fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

impl CatalogFolders {
    fn find(&self, id: &str) -> CoreResult<&CatalogFolder> {
        self.folders.iter().find(|f| f.id == id).ok_or_else(gone)
    }

    fn find_mut(&mut self, id: &str) -> CoreResult<&mut CatalogFolder> {
        self.folders
            .iter_mut()
            .find(|f| f.id == id)
            .ok_or_else(gone)
    }

    /// `Ok` when `parent` is the top level or names a folder.
    fn check_parent(&self, parent: Option<&str>) -> CoreResult<()> {
        match parent {
            Some(id) => self.find(id).map(|_| ()),
            None => Ok(()),
        }
    }

    /// "‹name› already exists here." when a folder in `parent`, other than `except`,
    /// has `name` ignoring case.
    fn check_free(&self, parent: Option<&str>, name: &str, except: Option<&str>) -> CoreResult<()> {
        let taken = self.folders.iter().any(|f| {
            f.parent.as_deref() == parent
                && Some(f.id.as_str()) != except
                && same_name(&f.name, name)
        });
        if taken {
            return Err(invalid(format!("{name} already exists here.")));
        }
        Ok(())
    }

    /// `folder-<n>`, one past the highest number in use.
    fn next_id(&self) -> String {
        let highest = self
            .folders
            .iter()
            .filter_map(|f| f.id.strip_prefix(ID_PREFIX)?.parse::<u64>().ok())
            .max()
            .unwrap_or(0);
        format!("{ID_PREFIX}{}", highest + 1)
    }

    /// Whether `id` is `ancestor` or sits somewhere inside it.
    fn is_within(&self, id: &str, ancestor: &str) -> bool {
        let mut seen = HashSet::new();
        let mut current = Some(id.to_owned());
        while let Some(at) = current {
            if at == ancestor {
                return true;
            }
            if !seen.insert(at.clone()) {
                return false;
            }
            current = self
                .folders
                .iter()
                .find(|f| f.id == at)
                .and_then(|f| f.parent.clone());
        }
        false
    }

    pub fn create(&mut self, parent: Option<&str>, name: &str) -> CoreResult<CatalogFolder> {
        let name = clean_name(name)?;
        self.check_parent(parent)?;
        self.check_free(parent, &name, None)?;
        let folder = CatalogFolder {
            id: self.next_id(),
            name,
            parent: parent.map(str::to_owned),
        };
        self.folders.push(folder.clone());
        Ok(folder)
    }

    pub fn rename(&mut self, id: &str, name: &str) -> CoreResult<()> {
        let name = clean_name(name)?;
        let parent = self.find(id)?.parent.clone();
        self.check_free(parent.as_deref(), &name, Some(id))?;
        self.find_mut(id)?.name = name;
        Ok(())
    }

    /// Moves a folder, with everything in it, under `parent` or to the top level.
    pub fn move_folder(&mut self, id: &str, parent: Option<&str>) -> CoreResult<()> {
        let name = self.find(id)?.name.clone();
        self.check_parent(parent)?;
        if parent.is_some_and(|p| self.is_within(p, id)) {
            return Err(invalid("A folder cannot go inside itself."));
        }
        self.check_free(parent, &name, Some(id))?;
        self.find_mut(id)?.parent = parent.map(str::to_owned);
        Ok(())
    }

    /// Removes a folder. Its clusters and subfolders move to its parent; no cluster
    /// leaves the catalog. Refused when a subfolder's name is taken in the parent.
    pub fn delete(&mut self, id: &str) -> CoreResult<()> {
        let parent = self.find(id)?.parent.clone();
        for child in self
            .folders
            .iter()
            .filter(|f| f.parent.as_deref() == Some(id))
        {
            let clash = self
                .folders
                .iter()
                .any(|f| f.parent == parent && f.id != id && same_name(&f.name, &child.name));
            if clash {
                let place = match &parent {
                    Some(p) => self.find(p)?.name.clone(),
                    None => TOP_LEVEL.to_owned(),
                };
                return Err(invalid(format!(
                    "{place} already has a folder named {}. Rename one of them first.",
                    child.name
                )));
            }
        }
        self.folders.retain(|f| f.id != id);
        for folder in &mut self.folders {
            if folder.parent.as_deref() == Some(id) {
                folder.parent.clone_from(&parent);
            }
        }
        match &parent {
            Some(p) => {
                for folder in self.placements.values_mut().filter(|f| f.as_str() == id) {
                    folder.clone_from(p);
                }
            }
            None => self.placements.retain(|_, folder| folder.as_str() != id),
        }
        Ok(())
    }

    /// Puts a cluster in `folder`, or at the top level with `None`.
    pub fn place(&mut self, cluster: &str, folder: Option<&str>) -> CoreResult<()> {
        match folder {
            Some(id) => {
                self.find(id)?;
                self.placements.insert(cluster.to_owned(), id.to_owned());
            }
            None => {
                self.placements.remove(cluster);
            }
        }
        Ok(())
    }

    /// Drops the placement of a cluster that left the catalog; true when it had one.
    pub fn forget_cluster(&mut self, cluster: &str) -> bool {
        self.placements.remove(cluster).is_some()
    }

    /// The tree as read from a file someone may have edited: a folder whose id an
    /// earlier one has is dropped, so what names that id goes to the first; a folder
    /// whose parent is missing, or that sits in a cycle, goes to the top level; a
    /// placement in a missing folder is dropped; and a folder named as an earlier
    /// sibling, ignoring case, is renamed "‹name› 2", "‹name› 3", …, the first that no
    /// sibling has.
    pub fn repaired(mut self) -> Self {
        let mut ids = HashSet::new();
        self.folders.retain(|f| ids.insert(f.id.clone()));
        for folder in &mut self.folders {
            if folder.parent.as_ref().is_some_and(|p| !ids.contains(p)) {
                folder.parent = None;
            }
        }
        for i in 0..self.folders.len() {
            let id = self.folders[i].id.clone();
            if let Some(parent) = self.folders[i].parent.clone() {
                if self.is_within(&parent, &id) {
                    self.folders[i].parent = None;
                }
            }
        }
        self.placements.retain(|_, folder| ids.contains(folder));
        self.number_clashing_names();
        self
    }

    fn number_clashing_names(&mut self) {
        for i in 0..self.folders.len() {
            let CatalogFolder { name, parent, .. } = self.folders[i].clone();
            let sibling_has = |folders: &[CatalogFolder], candidate: &str| {
                folders
                    .iter()
                    .any(|f| f.parent == parent && same_name(&f.name, candidate))
            };
            if !sibling_has(&self.folders[..i], &name) {
                continue;
            }
            // The number replaces the name's last characters when the name is too long
            // to take it, so a repaired name keeps the 64-character rule.
            let numbered = |n: u32| {
                let suffix = format!(" {n}");
                let keep = MAX_NAME_CHARS.saturating_sub(suffix.chars().count());
                let base: String = name.chars().take(keep).collect();
                format!("{}{suffix}", base.trim_end())
            };
            let mut n = 2;
            let mut free = numbered(n);
            while sibling_has(&self.folders, &free) {
                n += 1;
                free = numbered(n);
            }
            self.folders[i].name = free;
        }
    }
}

/// Each change is saved, then sends one `CatalogFoldersChanged` so every window
/// reads the tree again. A refused change, or one that leaves the tree as it was,
/// saves and sends nothing. A change whose save fails stays in memory; the first
/// failure of a run also sends a `StoreWarning` (P44).
impl AppCore {
    pub fn catalog_folders(&self) -> CatalogFolders {
        self.folders().get()
    }

    fn change_folders<R>(
        &self,
        f: impl FnOnce(&mut CatalogFolders) -> CoreResult<R>,
    ) -> CoreResult<R> {
        let (out, changed, warning) = self.folders().try_update_kept_if_changed(f)?;
        if let Some(warning) = warning {
            self.emit(CoreEvent::StoreWarning { warning });
        }
        if changed {
            self.emit(CoreEvent::CatalogFoldersChanged);
        }
        Ok(out)
    }

    pub fn catalog_folder_create(
        &self,
        parent: Option<&str>,
        name: &str,
    ) -> CoreResult<CatalogFolder> {
        self.change_folders(|all| all.create(parent, name))
    }

    pub fn catalog_folder_rename(&self, id: &str, name: &str) -> CoreResult<()> {
        self.change_folders(|all| all.rename(id, name))
    }

    pub fn catalog_folder_move(&self, id: &str, parent: Option<&str>) -> CoreResult<()> {
        self.change_folders(|all| all.move_folder(id, parent))
    }

    pub fn catalog_folder_delete(&self, id: &str) -> CoreResult<()> {
        self.change_folders(|all| all.delete(id))
    }

    /// Puts a listed cluster in `folder`, or any cluster at the top level with `None`.
    pub fn catalog_cluster_place(
        &self,
        cluster: &ClusterId,
        folder: Option<&str>,
    ) -> CoreResult<()> {
        if folder.is_some() && !self.catalog_lists(cluster) {
            return Err(IpcError::new(
                ErrorCode::NotFound,
                format!("no cluster {cluster}"),
            ));
        }
        self.change_folders(|all| all.place(cluster, folder))
    }

    /// After a pasted cluster left the catalog. A failed save is logged: the cluster
    /// is gone either way, and the next change saves the tree again.
    pub(crate) fn catalog_folders_forget(&self, cluster: &ClusterId) {
        if !self.catalog_folders().placements.contains_key(cluster) {
            return;
        }
        match self.change_folders(|all| Ok(all.forget_cluster(cluster))) {
            Ok(_) => {}
            Err(e) => tracing::warn!("catalog-folders.json: cannot drop a placement: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::{ErrorCode, IpcError};

    fn folder(id: &str, name: &str, parent: Option<&str>) -> CatalogFolder {
        CatalogFolder {
            id: id.to_owned(),
            name: name.to_owned(),
            parent: parent.map(str::to_owned),
        }
    }

    fn tree(folders: &[(&str, &str, Option<&str>)]) -> CatalogFolders {
        CatalogFolders {
            folders: folders
                .iter()
                .map(|(id, name, parent)| folder(id, name, *parent))
                .collect(),
            placements: BTreeMap::new(),
        }
    }

    fn parent_of<'a>(all: &'a CatalogFolders, id: &str) -> Option<&'a str> {
        all.folders
            .iter()
            .find(|f| f.id == id)
            .and_then(|f| f.parent.as_deref())
    }

    fn invalid(message: &str) -> IpcError {
        IpcError::new(ErrorCode::InvalidInput, message)
    }

    #[test]
    fn create_trims_the_name_and_numbers_the_ids() {
        let mut all = CatalogFolders::default();

        let prod = all.create(None, "  prod  ").unwrap();
        let eu = all.create(Some("folder-1"), "eu").unwrap();

        assert_eq!(prod, folder("folder-1", "prod", None));
        assert_eq!(eu, folder("folder-2", "eu", Some("folder-1")));
        assert_eq!(all.folders, [prod, eu]);
    }

    #[test]
    fn ids_continue_after_the_highest_one() {
        let mut all = tree(&[("folder-7", "a", None), ("imported", "b", None)]);

        assert_eq!(all.create(None, "c").unwrap().id, "folder-8");
    }

    #[test]
    fn a_folder_needs_a_name() {
        let mut all = CatalogFolders::default();

        let err = all.create(None, " \t ").unwrap_err();

        assert_eq!(err, invalid("A folder needs a name."));
        assert!(all.folders.is_empty());
    }

    #[test]
    fn a_name_has_at_most_64_characters() {
        let mut all = CatalogFolders::default();
        // Characters, not bytes: "é" is two bytes.
        all.create(None, &"é".repeat(64)).unwrap();

        let err = all.create(None, &"x".repeat(65)).unwrap_err();

        assert_eq!(err, invalid("A folder name has at most 64 characters."));
    }

    #[test]
    fn a_sibling_name_is_refused_ignoring_case() {
        let mut all = tree(&[
            ("folder-1", "prod", None),
            ("folder-2", "eu", Some("folder-1")),
        ]);

        let err = all.create(None, " PROD ").unwrap_err();
        assert_eq!(err, invalid("PROD already exists here."));
        let err = all.create(Some("folder-1"), "Eu").unwrap_err();
        assert_eq!(err, invalid("Eu already exists here."));

        // The same name under another parent is fine.
        all.create(Some("folder-2"), "prod").unwrap();
    }

    #[test]
    fn create_under_an_unknown_parent_is_not_found() {
        let mut all = CatalogFolders::default();

        let err = all.create(Some("folder-9"), "eu").unwrap_err();

        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[test]
    fn rename_follows_the_rules_but_may_change_only_the_case() {
        let mut all = tree(&[("folder-1", "prod", None), ("folder-2", "dev", None)]);

        all.rename("folder-1", " PROD ").unwrap();
        assert_eq!(all.folders[0].name, "PROD");

        assert_eq!(
            all.rename("folder-1", "Dev").unwrap_err(),
            invalid("Dev already exists here.")
        );
        assert_eq!(
            all.rename("folder-1", "").unwrap_err(),
            invalid("A folder needs a name.")
        );
        assert_eq!(
            all.rename("folder-9", "x").unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(all.folders[0].name, "PROD");
    }

    #[test]
    fn a_folder_cannot_move_into_itself_or_a_descendant() {
        let mut all = tree(&[
            ("folder-1", "a", None),
            ("folder-2", "b", Some("folder-1")),
            ("folder-3", "c", Some("folder-2")),
        ]);
        let cycle = invalid("A folder cannot go inside itself.");

        assert_eq!(
            all.move_folder("folder-1", Some("folder-1")).unwrap_err(),
            cycle
        );
        assert_eq!(
            all.move_folder("folder-1", Some("folder-3")).unwrap_err(),
            cycle
        );
        assert_eq!(parent_of(&all, "folder-1"), None);

        all.move_folder("folder-3", None).unwrap();
        assert_eq!(parent_of(&all, "folder-3"), None);
        all.move_folder("folder-1", Some("folder-3")).unwrap();
        assert_eq!(parent_of(&all, "folder-1"), Some("folder-3"));
    }

    #[test]
    fn a_move_is_refused_next_to_a_folder_of_the_same_name() {
        let mut all = tree(&[
            ("folder-1", "eu", None),
            ("folder-2", "prod", None),
            ("folder-3", "EU", Some("folder-2")),
        ]);

        let err = all.move_folder("folder-3", None).unwrap_err();

        assert_eq!(err, invalid("EU already exists here."));
        assert_eq!(
            all.move_folder("folder-9", None).unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(
            all.move_folder("folder-1", Some("folder-9"))
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn delete_moves_clusters_and_subfolders_to_the_parent() {
        let mut all = tree(&[
            ("folder-1", "a", None),
            ("folder-2", "b", Some("folder-1")),
            ("folder-3", "c", Some("folder-2")),
        ]);
        all.placements.insert("x".into(), "folder-2".into());
        all.placements.insert("y".into(), "folder-1".into());

        all.delete("folder-2").unwrap();

        assert_eq!(
            all.folders,
            [
                folder("folder-1", "a", None),
                folder("folder-3", "c", Some("folder-1"))
            ]
        );
        assert_eq!(
            all.placements.get("x").map(String::as_str),
            Some("folder-1")
        );

        all.delete("folder-1").unwrap();

        assert_eq!(all.folders, [folder("folder-3", "c", None)]);
        // At the top level a cluster has no placement; deleting never removes a cluster.
        assert!(all.placements.is_empty());
        assert_eq!(
            all.delete("folder-1").unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn delete_is_refused_when_a_subfolder_would_clash_in_the_parent() {
        let mut all = tree(&[
            ("folder-1", "c", None),
            ("folder-2", "a", None),
            ("folder-3", "C", Some("folder-2")),
            ("folder-4", "p", None),
            ("folder-5", "x", Some("folder-4")),
            ("folder-6", "b", Some("folder-4")),
            ("folder-7", "X", Some("folder-6")),
        ]);
        let before = all.clone();

        assert_eq!(
            all.delete("folder-2").unwrap_err(),
            invalid("Top level already has a folder named C. Rename one of them first.")
        );
        assert_eq!(
            all.delete("folder-6").unwrap_err(),
            invalid("p already has a folder named X. Rename one of them first.")
        );
        assert_eq!(all, before);
    }

    #[test]
    fn a_cluster_sits_in_at_most_one_folder() {
        let mut all = tree(&[("folder-1", "a", None), ("folder-2", "b", None)]);

        all.place("x", Some("folder-1")).unwrap();
        all.place("x", Some("folder-2")).unwrap();
        assert_eq!(all.placements.len(), 1);
        assert_eq!(all.placements["x"], "folder-2");

        all.place("x", None).unwrap();
        assert!(all.placements.is_empty());

        assert_eq!(
            all.place("x", Some("folder-9")).unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn forgetting_a_cluster_drops_its_placement() {
        let mut all = tree(&[("folder-1", "a", None)]);
        all.place("x", Some("folder-1")).unwrap();

        assert!(all.forget_cluster("x"));
        assert!(!all.forget_cluster("x"));
        assert!(all.placements.is_empty());
    }

    #[test]
    fn a_damaged_tree_is_repaired_on_load() {
        let mut all = tree(&[
            ("folder-1", "a", Some("folder-9")),
            ("folder-2", "b", Some("folder-3")),
            ("folder-3", "c", Some("folder-2")),
            ("folder-4", "d", Some("folder-1")),
        ]);
        all.placements.insert("x".into(), "folder-4".into());
        all.placements.insert("y".into(), "folder-9".into());

        let fixed = all.repaired();

        // A missing parent and a cycle both end at the top level.
        assert_eq!(parent_of(&fixed, "folder-1"), None);
        assert_eq!(parent_of(&fixed, "folder-4"), Some("folder-1"));
        let in_cycle = [parent_of(&fixed, "folder-2"), parent_of(&fixed, "folder-3")];
        assert!(in_cycle.contains(&None), "{in_cycle:?}");
        assert_eq!(
            fixed.placements,
            BTreeMap::from([("x".to_owned(), "folder-4".to_owned())])
        );
    }

    #[test]
    fn a_repeated_folder_id_keeps_the_first_folder() {
        let mut all = tree(&[
            ("folder-1", "a", None),
            ("folder-2", "b", None),
            ("folder-1", "c", Some("folder-2")),
            ("folder-3", "d", Some("folder-1")),
        ]);
        all.placements.insert("x".into(), "folder-1".into());

        let fixed = all.repaired();

        assert_eq!(
            fixed.folders,
            [
                folder("folder-1", "a", None),
                folder("folder-2", "b", None),
                folder("folder-3", "d", Some("folder-1")),
            ]
        );
        assert_eq!(
            fixed.placements,
            BTreeMap::from([("x".to_owned(), "folder-1".to_owned())])
        );
    }

    #[test]
    fn sibling_names_that_clash_ignoring_case_are_numbered() {
        let all = tree(&[
            ("folder-1", "prod", None),
            ("folder-2", "PROD", None),
            ("folder-3", "Prod 2", None),
            ("folder-4", "prod", None),
            ("folder-5", "eu", Some("folder-1")),
            ("folder-6", "EU", Some("folder-1")),
            ("folder-7", "eu", Some("folder-2")),
            // At the top level once its missing parent is repaired.
            ("folder-8", "Prod", Some("folder-9")),
        ]);

        let fixed = all.repaired();

        let names: Vec<_> = fixed
            .folders
            .iter()
            .map(|f| (f.id.as_str(), f.name.as_str()))
            .collect();
        assert_eq!(
            names,
            [
                ("folder-1", "prod"),
                ("folder-2", "PROD 3"),
                ("folder-3", "Prod 2"),
                ("folder-4", "prod 4"),
                ("folder-5", "eu"),
                ("folder-6", "EU 2"),
                ("folder-7", "eu"),
                ("folder-8", "Prod 5"),
            ]
        );
        assert_eq!(fixed.clone().repaired(), fixed);
    }

    #[test]
    fn a_numbered_name_keeps_within_64_characters() {
        let long = "é".repeat(64);
        let all = tree(&[
            ("folder-1", long.as_str(), None),
            ("folder-2", long.as_str(), None),
        ]);

        let fixed = all.repaired();

        let numbered = &fixed.folders[1].name;
        assert_eq!(numbered, &format!("{} 2", "é".repeat(62)));
        assert_eq!(numbered.chars().count(), 64);
    }

    #[test]
    fn serializes_for_the_ui() {
        let mut all = tree(&[("folder-1", "prod", None)]);
        all.place("c1", Some("folder-1")).unwrap();

        assert_eq!(
            serde_json::to_value(&all).unwrap(),
            serde_json::json!({
                "folders": [{ "id": "folder-1", "name": "prod", "parent": null }],
                "placements": { "c1": "folder-1" },
            })
        );
    }
}
