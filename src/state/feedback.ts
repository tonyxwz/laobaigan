import { redact } from "../pipeline/redact.ts";
import type { StateDb } from "./db.ts";

/**
 * Review feedback: what I told lbg while reviewing a proposal. It is not session
 * evidence (it never counts toward promotion and isn't extracted into nuggets);
 * drafting the same skill again sees it, so a redraft keeps my corrections.
 *
 *   chat    my turns in an interactive `lbg proposal revise` session
 *   revise  the feedback text of a one-shot `lbg proposal revise <id> "..."`
 *   edit    a hand edit (`lbg proposal edit`): the AI draft vs my version
 *   reject  the reason I gave when rejecting
 */
export const FEEDBACK_KINDS = ["chat", "revise", "edit", "reject"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export interface FeedbackRow {
  id: number;
  proposalId: number;
  kind: FeedbackKind;
  text: string;
  turns?: Turn[];
  diff?: string;
  createdAt: Date;
}

export interface FeedbackWithProposal extends FeedbackRow {
  proposalStatus: string;
  proposalKind: string;
}

type Row = Record<string, unknown>;

function toRow(r: Row): FeedbackWithProposal {
  return {
    id: Number(r.id),
    proposalId: Number(r.proposal_id),
    kind: r.kind as FeedbackKind,
    text: String(r.text),
    ...(r.turns ? { turns: JSON.parse(String(r.turns)) as Turn[] } : {}),
    ...(r.diff ? { diff: String(r.diff) } : {}),
    createdAt: new Date(Number(r.created_at)),
    proposalStatus: String(r.proposal_status ?? ""),
    proposalKind: String(r.proposal_kind ?? ""),
  };
}

const clean = (s: string) => redact(s).text;

export class Feedback {
  readonly db: StateDb;
  constructor(db: StateDb) {
    this.db = db;
  }

  /** Store feedback (redacted). Returns its id. */
  add(f: { proposalId: number; kind: FeedbackKind; text: string; turns?: Turn[]; diff?: string; at?: Date }): number {
    if (!FEEDBACK_KINDS.includes(f.kind)) throw new Error(`Bad feedback kind: ${f.kind}`);
    if (!this.db.db.prepare("SELECT 1 FROM proposal WHERE id = ?").get(f.proposalId)) throw new Error(`No proposal ${f.proposalId}`);
    const turns = f.turns?.map((t) => ({ role: t.role, text: clean(t.text) }));
    return Number(
      this.db.db
        .prepare("INSERT INTO feedback (proposal_id, kind, text, turns, diff, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(f.proposalId, f.kind, clean(f.text), turns ? JSON.stringify(turns) : null, f.diff ? clean(f.diff) : null, (f.at ?? new Date()).getTime())
        .lastInsertRowid,
    );
  }

  private query(where: string, ...args: (number | string)[]): FeedbackWithProposal[] {
    return (
      this.db.db
        .prepare(
          `SELECT f.*, p.status AS proposal_status, p.kind AS proposal_kind FROM feedback f JOIN proposal p ON p.id = f.proposal_id
           WHERE ${where} ORDER BY f.created_at, f.id`,
        )
        .all(...args) as Row[]
    ).map(toRow);
  }

  forProposal(proposalId: number): FeedbackWithProposal[] {
    return this.query("f.proposal_id = ?", proposalId);
  }

  /** Everything I said about this skill, across all its proposals, oldest first. */
  forNode(nodeId: number): FeedbackWithProposal[] {
    return this.query("p.node_id = ?", nodeId);
  }
}
