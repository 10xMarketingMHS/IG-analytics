// Performance Score — exact spec.
//
// Rates (each as a percentage of reach):
//   View Rate    = (views    ÷ reach) × 100
//   Like Rate    = (likes    ÷ reach) × 100
//   Comment Rate = (comments ÷ reach) × 100
//   Share Rate   = (shares   ÷ reach) × 100
//   Save Rate    = (saves    ÷ reach) × 100
//
// If reach is 0 or missing, all rates are 0 and the score is 0 (never
// divide by zero).
//
// Performance Score =
//   (View Rate × 20) + (Like Rate × 10) + (Comment Rate × 15)
//   + (Share Rate × 30) + (Save Rate × 25)

type Metrics = {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  reach: number;
};

export type Rates = {
  viewRate: number;
  likeRate: number;
  commentRate: number;
  shareRate: number;
  saveRate: number;
};

export function rates(m: Metrics): Rates {
  if (!m.reach || m.reach <= 0) {
    return { viewRate: 0, likeRate: 0, commentRate: 0, shareRate: 0, saveRate: 0 };
  }
  return {
    viewRate: (m.views / m.reach) * 100,
    likeRate: (m.likes / m.reach) * 100,
    commentRate: (m.comments / m.reach) * 100,
    shareRate: (m.shares / m.reach) * 100,
    saveRate: (m.saves / m.reach) * 100,
  };
}

export function performanceScore(m: Metrics): number {
  if (!m.reach || m.reach <= 0) return 0;
  const r = rates(m);
  return (
    r.viewRate * 20 +
    r.likeRate * 10 +
    r.commentRate * 15 +
    r.shareRate * 30 +
    r.saveRate * 25
  );
}

// Display helper: rounded integer with thousands separators, or "—" when
// there's no reach to score against.
export function formatScore(m: Metrics): string {
  if (!m.reach || m.reach <= 0) return "—";
  return Math.round(performanceScore(m)).toLocaleString();
}
