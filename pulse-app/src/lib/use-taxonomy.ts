import { useResource } from "@/lib/use-resource";
import type { Taxonomy } from "@/lib/types";

export function useTaxonomy() {
  const { data, loading, refetch } = useResource<Taxonomy>("/taxonomy");
  return { taxonomy: data ?? null, loading, refetch };
}
