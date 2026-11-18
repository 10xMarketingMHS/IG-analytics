import { useResource } from "@/lib/use-resource";

// Ads teams (server/src/routes/ad-teams.js; Settings › Tasks & time): the teams
// ads are made for — VSL, Longer Life, Webinar — each with its lead. An Ad task
// picks its team and is numbered within it; its task type stays shared, so an
// editor's goal is one target whatever team the ads are for.
export type AdTeam = { id: string; name: string; leadName: string; active: boolean; tasks: number };

export function useAdTeams() {
  const { data, refetch } = useResource<{ ready: boolean; teams: AdTeam[] }>("/ad-teams");
  return { adTeams: data ? (data.ready ? data.teams : []) : null, refetch };
}

// Where a task belongs, in words: an Ad task's team, else its brand.
export const placeOf = (t: { ad_team_name?: string | null; channel_name?: string | null }) => t.ad_team_name ?? t.channel_name ?? null;
