# The committee's standing table: the code lib/review/rules.ts runs, through
# the module Bend generates from this file (standing.bend.mjs). Edit here, then
# run `deno task bend:build`. The laws this table obeys are in /LAWS.bend.

import Base

type Standing is Data:
  NotStarted{}
  InReview{}
  Conflict{}
  Accepted{}
  Rejected{}
  NoQuorum{}

def is_not_started(acc: Nat, rej: Nat, abs: Nat) -> Bool:
  Nat.is_eq(Nat.add(acc, Nat.add(rej, abs)), 0n)

def is_accepted(+acc: Nat, rej: Nat, out: Nat) -> Bool:
  Bool.and(Nat.is_gt(acc, 0n), Nat.is_ge(acc, Nat.double(Nat.add(rej, out))))

def is_rejected(acc: Nat, +rej: Nat, out: Nat) -> Bool:
  Bool.and(Nat.is_gt(rej, 0n), Nat.is_ge(rej, Nat.double(Nat.add(acc, out))))

def is_no_quorum(acc: Nat, rej: Nat, abs: Nat, out: Nat) -> Bool:
  Bool.and(Nat.is_gt(abs, 0n), Bool.and(Nat.is_eq(out, 0n), Nat.is_eq(Nat.add(acc, rej), 0n)))

def is_conflict(+acc: Nat, +rej: Nat, +out: Nat) -> Bool:
  Bool.and(Nat.is_lt(Nat.add(acc, out), Nat.double(rej)), Nat.is_lt(Nat.add(rej, out), Nat.double(acc)))

def pick(ns: Bool, acc: Bool, rej: Bool, nq: Bool, con: Bool) -> Standing:
  match ns acc rej nq con:
    case True{} _ _ _ _:
      NotStarted{}
    case False{} True{} _ _ _:
      Accepted{}
    case False{} False{} True{} _ _:
      Rejected{}
    case False{} False{} False{} True{} _:
      NoQuorum{}
    case False{} False{} False{} False{} True{}:
      Conflict{}
    case False{} False{} False{} False{} False{}:
      InReview{}

def standing_of(+acc: Nat, +rej: Nat, +abs: Nat, +out: Nat) -> Standing:
  pick(is_not_started(acc, rej, abs), is_accepted(acc, rej, out), is_rejected(acc, rej, out), is_no_quorum(acc, rej, abs, out), is_conflict(acc, rej, out))

# ceil(2 * of / 3) with no division: 0, 1, 2, then two more for every three.
def needed(of: Nat) -> Nat:
  match of:
    case 0n:
      0n
    case 1n:
      1n
    case 2n:
      2n
    case 3n+p:
      2n+needed(p)

# needed, counted with a running total so the generated code loops instead of
# recursing: needed_from(of, k) is needed(of) + k.
def needed_from(of: Nat, k: Nat) -> Nat:
  match of:
    case 0n:
      k
    case 1n:
      1n+k
    case 2n:
      2n+k
    case 3n+p:
      needed_from(p, 2n+k)

# What the page prints: needed of those not abstaining. The abstainers are
# taken so that all four counts are checked at the boundary.
def needed_for(acc: Nat, rej: Nat, abs: Nat, out: Nat) -> Nat:
  needed_from(Nat.add(acc, Nat.add(rej, out)), 0n)
