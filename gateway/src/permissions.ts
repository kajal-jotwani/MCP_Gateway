import type { Member, Role } from './team.js';

/** Every active member may call tools, whatever the role. */
export function mayUseTools(member: Member): boolean {
  return member.active;
}

/** Servers and tools that only admins may list and call, set by admins on the Servers page. */
export interface ToolRestrictions {
  adminOnlyUpstreams: Set<string>;
  /** Keys from toolKey. */
  adminOnlyTools: Set<string>;
}

/** Identifies a tool by its upstream and its name on that upstream, which gateway renames do not change. */
export function toolKey(upstreamId: string, originalName: string): string {
  return `${upstreamId}/${originalName}`;
}

/**
 * Whether a member may see and call a tool. Admins may call every tool; members every tool that is
 * not on an admin-only server and not admin-only itself.
 */
export function mayCallTool(
  member: Member,
  tool: { upstreamId: string; originalName: string },
  restrictions: ToolRestrictions,
): boolean {
  if (!mayUseTools(member)) return false;
  if (isAdmin(member)) return true;
  return (
    !restrictions.adminOnlyUpstreams.has(tool.upstreamId) &&
    !restrictions.adminOnlyTools.has(toolKey(tool.upstreamId, tool.originalName))
  );
}

/** Admins manage upstream servers, members, invites and everyone's keys, and see the whole audit log. */
export function isAdmin(member: Member): boolean {
  return member.active && member.role === 'admin';
}

/** Members create and revoke their own keys; admins can do it for anyone. */
export function mayManageKeysOf(actor: Member, ownerId: string): boolean {
  return isAdmin(actor) || (actor.active && actor.id === ownerId);
}

/** Members delete and retry their own stores; admins can do it for anyone's. */
export function mayManageStoreOf(actor: Member, ownerId: string): boolean {
  return isAdmin(actor) || (actor.active && actor.id === ownerId);
}

/**
 * Why an actor may not apply a role or active change to a member, or undefined when allowed.
 * Admins cannot demote or deactivate themselves, so the team always keeps an admin who can sign in.
 */
export function memberChangeRefusal(
  actor: Member,
  target: Member,
  change: { role?: Role; active?: boolean },
): string | undefined {
  if (!isAdmin(actor)) return 'Only admins can change members.';
  if (actor.id === target.id && (change.role === 'member' || change.active === false)) {
    return 'Admins cannot demote or deactivate themselves.';
  }
  return undefined;
}

/** Whose audit entries an actor may read: admins see everyone's, members their own. */
export function auditScopeOf(actor: Member): string | undefined {
  return isAdmin(actor) ? undefined : actor.id;
}
