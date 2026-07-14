import { useResource } from "@/lib/use-resource";
import type { Task } from "@/lib/types";

export function useTasks() {
  const { data, refetch } = useResource<{ tasks: Task[] }>("/tasks");
  return { tasks: data?.tasks ?? null, refetch };
}
