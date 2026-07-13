import { useResource } from "@/lib/use-resource";
import type { Editor } from "@/lib/types";

export function useEditors() {
  const { data, refetch } = useResource<{ editors: Editor[] }>("/editors");
  return { editors: data?.editors ?? null, refetch };
}
