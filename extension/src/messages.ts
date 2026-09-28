/** The one message shape content.ts sends and background.ts answers. */
export interface ScoreEventRequest {
  type: "SCORE_EVENT";
  title: string;
}

export type ScoreEventResponse =
  | { kind: "verdict"; favor: number; intensity: number }
  | { kind: "recusal" }
  | { kind: "needs-detail" }
  | { kind: "no-birth-input" }
  | { kind: "error"; message: string };
