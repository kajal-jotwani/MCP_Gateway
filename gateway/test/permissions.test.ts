import { describe, expect, it } from 'vitest';

import {
  auditScopeOf,
  isAdmin,
  mayCallTool,
  mayManageKeysOf,
  mayManageStoreOf,
  mayUseTools,
  memberChangeRefusal,
  toolKey,
} from '../src/permissions.js';
import type { Member } from '../src/team.js';

const admin: Member = { id: 'a', email: 'admin@example.com', name: 'Admin', role: 'admin', active: true };
const member: Member = { id: 'm', email: 'member@example.com', name: 'Member', role: 'member', active: true };
const inactiveAdmin: Member = { ...admin, id: 'x', active: false };

describe('permissions', () => {
  it('lets every active member use tools and nobody inactive', () => {
    expect(mayUseTools(admin)).toBe(true);
    expect(mayUseTools(member)).toBe(true);
    expect(mayUseTools({ ...member, active: false })).toBe(false);
  });

  it('lets members call tools unless the tool or its server is admin-only, and admins call all', () => {
    const tool = { upstreamId: 'u1', originalName: 'create_product' };
    const none = { adminOnlyUpstreams: new Set<string>(), adminOnlyTools: new Set<string>() };
    const toolOnly = { ...none, adminOnlyTools: new Set([toolKey('u1', 'create_product')]) };
    const server = { ...none, adminOnlyUpstreams: new Set(['u1']) };

    expect(mayCallTool(member, tool, none)).toBe(true);
    expect(mayCallTool(member, tool, toolOnly)).toBe(false);
    expect(mayCallTool(member, { ...tool, originalName: 'list_orders' }, toolOnly)).toBe(true);
    expect(mayCallTool(member, { ...tool, upstreamId: 'u2' }, toolOnly)).toBe(true);
    expect(mayCallTool(member, tool, server)).toBe(false);
    expect(mayCallTool(admin, tool, server)).toBe(true);
    expect(mayCallTool(admin, tool, toolOnly)).toBe(true);
    expect(mayCallTool(inactiveAdmin, tool, none)).toBe(false);
  });

  it('treats only active admins as admins', () => {
    expect(isAdmin(admin)).toBe(true);
    expect(isAdmin(member)).toBe(false);
    expect(isAdmin(inactiveAdmin)).toBe(false);
  });

  it('lets members manage their own keys and admins anyone’s', () => {
    expect(mayManageKeysOf(member, member.id)).toBe(true);
    expect(mayManageKeysOf(member, admin.id)).toBe(false);
    expect(mayManageKeysOf(admin, member.id)).toBe(true);
    expect(mayManageKeysOf(inactiveAdmin, member.id)).toBe(false);
  });

  it('lets members manage their own stores and admins anyone’s', () => {
    expect(mayManageStoreOf(member, member.id)).toBe(true);
    expect(mayManageStoreOf(member, admin.id)).toBe(false);
    expect(mayManageStoreOf(admin, member.id)).toBe(true);
    expect(mayManageStoreOf(inactiveAdmin, member.id)).toBe(false);
  });

  it('lets only admins change members, and not demote or deactivate themselves', () => {
    expect(memberChangeRefusal(member, admin, { active: false })).toBe('Only admins can change members.');
    expect(memberChangeRefusal(admin, member, { role: 'admin' })).toBeUndefined();
    expect(memberChangeRefusal(admin, member, { active: false })).toBeUndefined();
    expect(memberChangeRefusal(admin, admin, { role: 'member' })).toBe(
      'Admins cannot demote or deactivate themselves.',
    );
    expect(memberChangeRefusal(admin, admin, { active: false })).toBe(
      'Admins cannot demote or deactivate themselves.',
    );
  });

  it('shows admins every audit entry and members only their own', () => {
    expect(auditScopeOf(admin)).toBeUndefined();
    expect(auditScopeOf(member)).toBe(member.id);
  });
});
