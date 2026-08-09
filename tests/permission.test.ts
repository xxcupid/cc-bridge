import { describe, expect, it } from 'vitest';
import { decidePermission } from '../src/domain/permission.js';

describe('decidePermission', () => {
  it('allows read-only operations in default mode', () => {
    expect(decidePermission('default', 'workspace', 'read-only').outcome).toBe('allow');
  });

  it('asks for workspace writes in default mode', () => {
    expect(decidePermission('default', 'workspace', 'workspace').outcome).toBe('ask');
  });

  it('allows operations in yolo mode within maxAccess', () => {
    expect(decidePermission('yolo', 'workspace', 'workspace').outcome).toBe('allow');
  });

  it('denies operations above maxAccess in every mode', () => {
    expect(decidePermission('yolo', 'workspace', 'full').outcome).toBe('deny');
  });
});
