try {
  const stored = localStorage.getItem("tmp-sync-theme");
  const theme =
    stored === "light" || stored === "dark"
      ? stored
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
} catch {
  // The application applies the system theme after mounting.
}
