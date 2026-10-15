import { useEffect } from "react";
import { useResource } from "@/lib/use-resource";
import { onTasksChanged } from "@/lib/task-events";
import type { Task } from "@/lib/types";

export function useTasks() {
  const { data, refetch } = useResource<{ tasks: Task[] }>("/tasks");
  // Reload when someone else changes a task (see task-events.ts).
  useEffect(() => onTasksChanged(() => { refetch().catch(() => {}); }), [refetch]);
  return { tasks: data?.tasks ?? null, refetch };
}
