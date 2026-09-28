import { firmnessFor } from "../explain";

export type ThumbDirection = "up" | "down" | "sideways";

export function thumbDirectionFor(favor: number): ThumbDirection {
  return firmnessFor(favor) === "Tentatively" ? "sideways" : favor >= 0.5 ? "up" : "down";
}

export function headlineFor(favor: number): string {
  const firm = firmnessFor(favor) === "Firmly";
  const up = favor >= 0.5;
  if (firm && up) return "Do it, lady!";
  if (firm && !up) return "Girl, NO";
  return up ? "Hmmm yah" : "Hmmm nah";
}
