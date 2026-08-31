/* The names this deployment answers to itself.
 *
 * A tool list is flat: the model sees one namespace, and so does the provider,
 * which rejects the whole request when two entries share a name. Linear offers
 * list_projects and list_documents; so do we. Nothing noticed, because the
 * collision only appears once a deferred tool is warmed into the request, and
 * then every message in that conversation fails with "Tool names must be
 * unique" -- a provider error about a request the person never sees, from a
 * conversation that was working a moment before.
 *
 * So a server may not take a name we use. The tool is left out with a fault
 * saying why, which is a smaller loss than a conversation that cannot answer,
 * and an honest one: the briefing says what happened rather than the model
 * discovering a tool that turns out to be ours.
 *
 * Written as a list rather than gathered from the families that define them,
 * because gathering means importing every family here and each of those
 * already imports what this would have to import. The test beside this file
 * walks the families and fails if the list drifts.
 */

export function reservedToolNames(): string[] {
  return [
    // workspace
    "list_files", "read_file", "write_file",
    // artifacts
    "write_artifact", "read_artifact", "search_artifacts", "edit_artifact",
    // scripts and environments
    "run_script", "serve_env", "delegate_to_joule_code",
    // tasks
    "list_tasks", "schedule_task", "change_task", "run_task_now", "delete_task",
    // workflows
    "list_workflows", "show_workflow", "draft_workflow", "connect_steps", "publish_workflow",
    "add_step", "change_step", "remove_step", "schedule_workflow", "change_workflow",
    "run_workflow", "delete_workflow", "list_secrets",
    // bots
    "list_bots", "change_bot", "test_bot_draft",
    // agents
    "list_agents", "show_agent", "create_agent", "change_agent", "delete_agent",
    // projects
    "list_projects", "create_project", "move_to_project", "leave_project",
    // knowledge and skills
    "add_document", "list_documents", "forget_document", "set_banner",
    "list_skills", "create_skill", "change_skill", "use_skill",
    // mail and the web
    "send_email",
    "search_web",
    // the door to the deferred ones
    "find_tools",
  ];
}

export function reservedHere(name: string): bool {
  let held = reservedToolNames();
  let i: int = 0;
  while (i < held.length) {
    if (held[i] == name) {
      return true;
    }
    i = i + 1;
  }
  return false;
}
