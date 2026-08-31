/**
 * Everything this package offers, in one place.
 *
 * Test doubles are deliberately absent — they live at `@cortana/core/testing`,
 * so that importing one from production code has to be spelled out.
 */

export type { Clock } from './clock.ts';
export { systemClock } from './clock.ts';
export type { AppErrorOptions, ErrorCategory, ErrorDetail } from './errors.ts';
export { AppError, isAppError, isBug } from './errors.ts';
export { PACKAGE_SCOPE, PRODUCT_NAME } from './identity.ts';
export type { Brand, InstanceId, Uuid } from './ids.ts';
export { newInstanceId, timestampOf, uuidV7 } from './ids.ts';
export type { TrustLevel } from './trust.ts';
