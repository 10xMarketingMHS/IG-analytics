import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

type Theme = "light" | "dark";
// The accent colour: tints the background and every highlight (index.css
// --acH). Picked by each person, remembered per browser.
export type Accent = "violet" | "blue" | "green";
export const ACCENTS: { key: Accent; label: string; swatch: string }[] = [
  { key: "violet", label: "Violet", swatch: "oklch(0.55 0.21 290)" },
  { key: "blue", label: "Blue", swatch: "oklch(0.55 0.21 255)" },
  { key: "green", label: "Green", swatch: "oklch(0.55 0.17 160)" },
];

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
    return a === "blue" || a === "green" ? a : "violet";
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
