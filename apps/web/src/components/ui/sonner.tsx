import { Toaster as Sonner, type ToasterProps } from "sonner";

/** Тосты (shadcn/ui sonner); тема всегда тёмная — светлой темы у приложения нет. */
const Toaster = (props: ToasterProps) => (
  <Sonner
    theme="dark"
    className="toaster group"
    style={
      {
        "--normal-bg": "var(--popover)",
        "--normal-text": "var(--popover-foreground)",
        "--normal-border": "var(--border)",
      } as React.CSSProperties
    }
    {...props}
  />
);

export { Toaster };
