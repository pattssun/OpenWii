/**
 * OpenWii core — the motion engine shared by every channel.
 *
 * Renderer-agnostic and game-agnostic by design: nothing in here knows what a
 * game object is. Games import what they need and bring their own
 * renderer, 2D or 3D.
 */
export * from './orientation.js';
export * from './filter.js';
export * from './calibration.js';
export * from './pointer.js';
export * from './trail.js';
export * from './audio.js';
export * from './net.js';
export * from './gesture.js';
export * from './channel.js';
