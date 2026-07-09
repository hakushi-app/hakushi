mod collab;
mod credentials;
mod error;
mod fs_commands;
mod git;
mod index_store;
mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            fs_commands::list_tree,
            fs_commands::read_text_file,
            fs_commands::write_text_file,
            fs_commands::create_page,
            fs_commands::rename_path,
            fs_commands::delete_path,
            fs_commands::write_export_file,
            fs_commands::write_site_files,
            fs_commands::write_temp_file,
            workspace::ensure_default_workspace,
            index_store::index_put_pages,
            index_store::index_remove_pages,
            index_store::index_clear,
            index_store::index_lookup,
            index_store::index_backlinks,
            git::commands::git_backend_info,
            git::commands::git_init,
            git::commands::git_status,
            git::commands::git_commit,
            git::commands::git_log,
            git::commands::git_branches,
            git::commands::git_create_branch,
            git::commands::git_checkout_branch,
            git::commands::git_file_at_commit,
            git::commands::git_revert_file,
            git::commands::git_merge_branch,
            git::commands::git_conflict_versions,
            git::commands::git_merge_resolve,
            git::commands::git_remote_get,
            git::commands::git_remote_set,
            git::commands::git_sync,
            credentials::credential_set,
            credentials::credential_clear,
            credentials::credential_has,
            collab::collab_create_issue,
            collab::collab_issue_event,
            collab::collab_list_issues,
            collab::collab_get_issue,
            collab::collab_create_pr,
            collab::collab_pr_event,
            collab::collab_list_prs,
            collab::collab_get_pr,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
