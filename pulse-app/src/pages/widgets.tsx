import { PomodoroPanel, Switch, WidgetPanel } from "@/components/widget-panels";
import { useWidgets, WIDGETS } from "@/lib/widgets";
import "@/components/widgets.css";

// Widgets (the sidebar's last item): small helpers for whoever wants them. Anyone
// can use any of them here. What's running shows in the bar along the bottom
// (components/widget-bar.tsx), and each person chooses which ones are on their
// own break screen (components/break-overlay.tsx).
export function WidgetsPage() {
  const w = useWidgets();
  return (
    <div className="wg-page">
      <section className="wg-card wide">
        <div className="wg-head">
          <span className="wg-ic" aria-hidden="true">🍅</span>
          <span><b>Pomodoro and Focus Mode</b><small>Work in focused rounds with short breaks. While it runs, it shows in the bar at the bottom of every page.</small></span>
        </div>
        <PomodoroPanel />
      </section>
      <div className="wg-grid">
        {WIDGETS.map((x) => (
          <section className="wg-card" key={x.key}>
            <div className="wg-head">
              <span className="wg-ic" aria-hidden="true">{x.icon}</span>
              <span><b>{x.name}</b><small>{x.blurb}</small></span>
            </div>
            <div className="wg-body"><WidgetPanel k={x.key} /></div>
            <div className="wg-foot">
              <Switch on={w.picks.includes(x.key)} label="On my break screen" onChange={() => w.togglePick(x.key)} />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
