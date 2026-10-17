import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Склеивает классы Tailwind с разрешением конфликтов (shadcn/ui). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
