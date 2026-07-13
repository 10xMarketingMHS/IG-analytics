import { useResource } from "@/lib/use-resource";
import type { Post } from "@/lib/types";

// Shared, cached posts list — used by the dashboard, leaderboard, insights,
// format analytics, the posts grid, and the sidebar badge. One cache means
// navigating between them is instant (revalidates in the background).
export function usePosts() {
  const { data, loading, refetch } = useResource<{ posts: Post[] }>("/posts");
  return { posts: data?.posts ?? null, loading, refetch };
}
