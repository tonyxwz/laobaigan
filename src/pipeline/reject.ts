import { Feedback } from "../state/feedback.ts";
import { Proposals } from "../state/proposals.ts";
import {
  type RejectedTopic,
  type RejectionKind,
  Rejections,
} from "../state/rejections.ts";
import type { Tree } from "../state/tree.ts";

export interface RejectResult {
  memoryId: number;
  /** pending: the next lbg run classifies it. active: I gave the kind (or there was no reason). */
  status: "pending" | "active";
  kind?: RejectionKind;
  /** Evidence forgotten now (outdated, or --forget). */
  forgotten?: number;
}

/**
 * Reject a proposal. No model call: it stores the reason as review feedback and
 * leaves a rejection memory that the next `lbg run` classifies (or, with `kind`,
 * is active right away with the reason as its rule).
 */
export function rejectProposal(
  tree: Tree,
  id: number,
  reason?: string,
  opts: {
    kind?: RejectionKind;
    targetNodeId?: number;
    forget?: boolean;
    expireDays?: number;
  } = {},
): RejectResult {
  const props = new Proposals(tree.db);
  const p = props.mustGet(id);
  const text = reason?.trim() ?? "";
  const node = tree.getNode(p.nodeId);
  const scope = node
    ? { scope: node.scope, ...(node.repo ? { repo: node.repo } : {}) }
    : { scope: p.scope, ...(p.repo ? { repo: p.repo } : {}) };
  if (opts.targetNodeId !== undefined) {
    if (opts.kind !== "wrong-place")
      throw new Error("--to only goes with --kind wrong-place");
    const t = tree.getNode(opts.targetNodeId);
    if (!t || t.depth !== 1)
      throw new Error(`--to ${opts.targetNodeId}: not a skill`);
    if (t.id === p.nodeId)
      throw new Error("--to: that's the rejected skill itself");
    if (
      t.scope !== scope.scope ||
      (t.repo ?? undefined) !== (scope.repo ?? undefined)
    )
      throw new Error(`--to ${t.id}: a skill of another scope`);
  }
  const topic: RejectedTopic = {
    ...((p.skillName ?? node?.name)
      ? { name: p.skillName ?? node!.name! }
      : {}),
    title: node?.title ?? p.skillName ?? `skill #${p.nodeId}`,
    ...(node?.description ? { description: node.description } : {}),
    proposalKind: p.kind,
    evidence: p.nuggetIds
      .slice(0, 12)
      .map((n) => tree.db.getNugget(n))
      .filter((n): n is NonNullable<typeof n> => !!n)
      .map((n) => ({ id: n.id, title: n.title })),
  };
  const done = (r: RejectResult): RejectResult => {
    // --forget: its evidence stops counting whatever the kind (given back if the memory is forgotten).
    if (opts.forget)
      r.forgotten = tree.forgetNuggets(
        new Rejections(tree.db).proposalNuggets(id),
        `forgotten on reject (rejection #${r.memoryId})`,
        r.memoryId,
      );
    else
      r.forgotten = tree.db
        .nuggets()
        .filter((n) => n.forgottenMemory === r.memoryId).length;
    return r;
  };
  return tree.db.tx(() => {
    props.markRejected(id, text || undefined);
    // The reason is review feedback: the next draft of this skill (or a nearby one) sees it.
    const feedbackId = new Feedback(tree.db).add({
      proposalId: id,
      kind: "reject",
      text,
    });
    const mem = new Rejections(
      tree.db,
      opts.expireDays !== undefined ? { expireDays: opts.expireDays } : {},
    );
    const base = {
      proposalId: id,
      feedbackId,
      nodeId: p.nodeId,
      ...scope,
      topic,
    };
    if (opts.kind) {
      const memoryId = mem.add({
        ...base,
        kind: opts.kind,
        rule: text || `rejected as ${opts.kind}`,
        ...(opts.targetNodeId !== undefined
          ? { targetNodeId: opts.targetNodeId }
          : {}),
      });
      return done({ memoryId, status: "active" as const, kind: opts.kind });
    }
    if (!text) {
      // Nothing to classify: "not now". Unlocked, so I can still edit it.
      const memoryId = mem.add({
        ...base,
        kind: "later",
        rule: "rejected without a reason",
        locked: false,
      });
      return done({
        memoryId,
        status: "active" as const,
        kind: "later" as const,
      });
    }
    return done({ memoryId: mem.add(base), status: "pending" as const });
  });
}
