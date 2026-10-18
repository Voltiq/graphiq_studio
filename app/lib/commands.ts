// Command families — the menu ids that carry their argument inside the id
// ("fx-add-dropShadow" adds the dropShadow effect), and the typed accessors that
// read it back out. TODO 1.1.
//
// Every other command is DIRECT: one id, one handler, in the editor's dispatch
// table, whose type (`{ [K in DirectCommand]: … }`) makes a missing or stray
// entry a compile error. Families go through the functions below instead, and
// their RETURN TYPES are the check that used to be an unchecked `as FxKey`: if a
// menu grows "fx-add-sparkle" and FxKey has no "sparkle", this file stops
// compiling.

import type { CommandId } from "./menus";
import type { FxKey } from "./effects";
import type { FilterType } from "./filters";

/** The part of `T` after prefix `P`. */
type Suffix<T extends string, P extends string> = T extends `${P}${infer S}` ? S : never;

/** Show or hide one panel: "window-<panel>". (window-reset is direct.) */
export type PanelCommand = Exclude<Extract<CommandId, `window-${string}`>, "window-reset">;
/** Add one of the "extra" adjustment layers: "adj-x-<type>". */
export type ExtraAdjustmentCommand = Extract<CommandId, `adj-x-${string}`>;
/** Add an adjustment layer: "adj-<type>". (The two tone ones are direct.) */
export type AdjustmentCommand = Exclude<
  Extract<CommandId, `adj-${string}`>,
  ExtraAdjustmentCommand | "adj-tone-curves" | "adj-tone-levels"
>;
/** Add a layer effect: "fx-add-<key>". */
export type EffectCommand = Extract<CommandId, `fx-add-${string}`>;
/** Add a smart filter: "filter-add-<type>". */
export type FilterCommand = Extract<CommandId, `filter-add-${string}`>;

export type FamilyCommand =
  | PanelCommand
  | ExtraAdjustmentCommand
  | AdjustmentCommand
  | EffectCommand
  | FilterCommand;
/** One id, one handler — the editor's dispatch table must cover exactly these. */
export type DirectCommand = Exclude<CommandId, FamilyCommand>;

export const effectOf = (id: EffectCommand): FxKey =>
  id.slice("fx-add-".length) as Suffix<EffectCommand, "fx-add-">;
export const filterOf = (id: FilterCommand): FilterType =>
  id.slice("filter-add-".length) as Suffix<FilterCommand, "filter-add-">;
export const adjustmentOf = (id: AdjustmentCommand) =>
  id.slice("adj-".length) as Suffix<AdjustmentCommand, "adj-">;
export const extraAdjustmentOf = (id: ExtraAdjustmentCommand) =>
  id.slice("adj-x-".length) as Suffix<ExtraAdjustmentCommand, "adj-x-">;
export const panelOf = (id: PanelCommand) => id.slice("window-".length) as Suffix<PanelCommand, "window-">;

/**
 * Which family a NON-direct command belongs to. Callers look the id up in the
 * direct table first, so this only ever sees family members — which is what
 * keeps "adj-tone-curves" from being read as an "adj-" family member here.
 */
export function familyOf(
  id: FamilyCommand,
):
  | { kind: "panel"; id: PanelCommand }
  | { kind: "extraAdjustment"; id: ExtraAdjustmentCommand }
  | { kind: "adjustment"; id: AdjustmentCommand }
  | { kind: "effect"; id: EffectCommand }
  | { kind: "filter"; id: FilterCommand } {
  if (id.startsWith("window-")) return { kind: "panel", id: id as PanelCommand };
  if (id.startsWith("adj-x-")) return { kind: "extraAdjustment", id: id as ExtraAdjustmentCommand };
  if (id.startsWith("adj-")) return { kind: "adjustment", id: id as AdjustmentCommand };
  if (id.startsWith("fx-add-")) return { kind: "effect", id: id as EffectCommand };
  return { kind: "filter", id: id as FilterCommand };
}
