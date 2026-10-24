import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

type Theme = "light" | "dark";
// The accent colour: tints the background and every highlight. Each is a
// pair of hues — the accent and the colour its gradients blend into — set as
// --acH / --acH2 in index.css (the same eight as My Profile's palette).
// Picked by each person, remembered per browser.
export type Accent = "violet" | "indigo" | "blue" | "orchid" | "pink" | "green" | "amber" | "sunset";
const pair = (h: number, h2: number) => `linear-gradient(135deg,oklch(0.56 0.22 ${h}),oklch(0.66 0.18 ${h2}))`;
export const ACCENTS: { key: Accent; label: string; swatch: string }[] = [
  { key: "violet", label: "Violet", swatch: pair(290, 330) },
  { key: "indigo", label: "Indigo", swatch: pair(272, 215) },
  { key: "blue", label: "Ocean", swatch: pair(252, 205) },
  { key: "orchid", label: "Orchid", swatch: pair(305, 350) },
  { key: "pink", label: "Pink", swatch: pair(350, 295) },
  { key: "green", label: "Green", swatch: pair(155, 200) },
  { key: "amber", label: "Amber", swatch: pair(65, 300) },
  { key: "sunset", label: "Sunset", swatch: pair(28, 68) },
];
const isAccent = (a: string | null): a is Accent => ACCENTS.some((x) => x.key === a);

type ThemeContextValue = {
  theme: Theme;
  toggle: () => void;
  accent: Accent;
  setAccent: (a: Accent) => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = "pulse-theme";
const ACCENT_KEY = "pulse-accent";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "dark",
  );
  const [accent, setAccent] = useState<Accent>(() => {
    const a = localStorage.getItem(ACCENT_KEY);
    return isAccent(a) ? a : "violet";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    // On a phone the status bar takes this colour: the app's background.
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f3f0fb" : "#0a0713");
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-accent", accent);
    localStorage.setItem(ACCENT_KEY, accent);
  }, [accent]);

  function toggle() {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  return (
    <ThemeContext.Provider value={{ theme, toggle, accent, setAccent }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
