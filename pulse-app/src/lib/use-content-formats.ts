import { useResource } from "@/lib/use-resource";
import type { ContentFormatDef } from "@/lib/types";

export function useContentFormats() {
  const { data, refetch } = useResource<{ contentFormats: ContentFormatDef[] }>("/content-formats");
  return { contentFormats: data?.contentFormats ?? null, refetch };
}
