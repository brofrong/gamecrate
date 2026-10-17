import { LoaderCircle } from "lucide-react";

export function FullscreenLoader() {
  return (
    <main className="flex min-h-dvh items-center justify-center">
      <LoaderCircle className="size-6 animate-spin text-muted-foreground" />
    </main>
  );
}
