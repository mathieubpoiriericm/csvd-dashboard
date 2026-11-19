# The committee's standing rule: what must hold of lib/review/standing.bend.
# The maintainer's file. Each law is an open claim here and is proved by the
# def of the same name in PROOF.bend; `deno task bend:check` is the gate.
#
# a, r, b, o: the members accepting, rejecting, abstaining and outstanding.

import Base
import ./lib/review/standing.bend as S

# True when both are the same standing.
def same(x: S.Standing, y: S.Standing) -> Bool:
  match x y:
    case S.NotStarted{} S.NotStarted{}:
      True{}
    case S.InReview{} S.InReview{}:
      True{}
    case S.Conflict{} S.Conflict{}:
      True{}
    case S.Accepted{} S.Accepted{}:
      True{}
    case S.Rejected{} S.Rejected{}:
      True{}
    case S.NoQuorum{} S.NoQuorum{}:
      True{}
    case _ _:
      False{}

# True when at most one of the five is.
def at_most_one(p: Bool, q: Bool, s: Bool, t: Bool, u: Bool) -> Bool:
  match p q s t u:
    case False{} False{} False{} False{} _:
      True{}
    case False{} False{} False{} True{} False{}:
      True{}
    case False{} False{} True{} False{} False{}:
      True{}
    case False{} True{} False{} False{} False{}:
      True{}
    case True{} False{} False{} False{} False{}:
      True{}
    case _ _ _ _ _:
      False{}

# True when none of the five is.
def none(p: Bool, q: Bool, s: Bool, t: Bool, u: Bool) -> Bool:
  match p q s t u:
    case False{} False{} False{} False{} False{}:
      True{}
    case _ _ _ _ _:
      False{}

# True for the three standings a member's objection can cause: conflict,
# rejected and no quorum.
def adverse(s: S.Standing) -> Bool:
  match s:
    case S.Conflict{}:
      True{}
    case S.Rejected{}:
      True{}
    case S.NoQuorum{}:
      True{}
    case _:
      False{}

# 1. Finality. A settled gene keeps its standing whatever one outstanding
#    member then answers.
law accepted_final_accept:
  for +a: Nat
  for +r: Nat
  for +b: Nat
  for +o: Nat
  for e: {S.standing_of(a, r, b, 1n+o) == S.Accepted{} : S.Standing}
  {S.standing_of(1n+a, r, b, o) == S.Accepted{} : S.Standing}

law accepted_final_reject:
  for +a: Nat
  for +r: Nat
  for +b: Nat
  for +o: Nat
  for e: {S.standing_of(a, r, b, 1n+o) == S.Accepted{} : S.Standing}
  {S.standing_of(a, 1n+r, b, o) == S.Accepted{} : S.Standing}

law accepted_final_abstain:
  for +a: Nat
  for +r: Nat
  for +b: Nat
  for +o: Nat
  for e: {S.standing_of(a, r, b, 1n+o) == S.Accepted{} : S.Standing}
  {S.standing_of(a, r, 1n+b, o) == S.Accepted{} : S.Standing}

law rejected_final_accept:
  for +a: Nat
  for +r: Nat
  for +b: Nat
  for +o: Nat
  for e: {S.standing_of(a, r, b, 1n+o) == S.Rejected{} : S.Standing}
  {S.standing_of(1n+a, r, b, o) == S.Rejected{} : S.Standing}

law rejected_final_reject:
  for +a: Nat
  for +r: Nat
  for +b: Nat
  for +o: Nat
  for e: {S.standing_of(a, r, b, 1n+o) == S.Rejected{} : S.Standing}
  {S.standing_of(a, 1n+r, b, o) == S.Rejected{} : S.Standing}

law rejected_final_abstain:
  for +a: Nat
  for +r: Nat
  for +b: Nat
  for +o: Nat
  for e: {S.standing_of(a, r, b, 1n+o) == S.Rejected{} : S.Standing}
  {S.standing_of(a, r, 1n+b, o) == S.Rejected{} : S.Standing}

law conflict_final_accept:
  for +a: Nat
  for +r: Nat
  for +b: Nat
  for +o: Nat
  for e: {S.standing_of(a, r, b, 1n+o) == S.Conflict{} : S.Standing}
  {S.standing_of(1n+a, r, b, o) == S.Conflict{} : S.Standing}

law conflict_final_reject:
  for +a: Nat
  for +r: Nat
  for +b: Nat
  for +o: Nat
  for e: {S.standing_of(a, r, b, 1n+o) == S.Conflict{} : S.Standing}
  {S.standing_of(a, 1n+r, b, o) == S.Conflict{} : S.Standing}

law conflict_final_abstain:
  for +a: Nat
  for +r: Nat
  for +b: Nat
  for +o: Nat
  for e: {S.standing_of(a, r, b, 1n+o) == S.Conflict{} : S.Standing}
  {S.standing_of(a, r, 1n+b, o) == S.Conflict{} : S.Standing}

# 2. Exclusive rows. No tally satisfies two of the table's five conditions,
#    so the order of the rows cannot matter.
law rows_exclusive:
  for +a: Nat
  for +r: Nat
  for +b: Nat
  for +o: Nat
  {at_most_one(S.is_not_started(a, r, b), S.is_accepted(a, r, o), S.is_rejected(a, r, o), S.is_no_quorum(a, r, b, o), S.is_conflict(a, r, o)) == True{} : Bool}

# 3. Needed is two thirds, rounded up.
law needed_reaches_two_thirds:
  for +n: Nat
  {Nat.is_ge(Nat.mul(3n, S.needed(n)), Nat.double(n)) == True{} : Bool}

law needed_is_least:
  for +n: Nat
  {Nat.is_lt(Nat.mul(3n, S.needed(n)), Nat.add(Nat.double(n), 3n)) == True{} : Bool}

# 4. Settling point. When someone has not abstained, a gene is accepted
#    exactly when the accepts reach `needed`, and rejected exactly when the
#    rejects do.
law accepted_at_needed:
  for +a: Nat
  for +r: Nat
  for +b: Nat
  for +o: Nat
  for e: {Nat.is_gt(Nat.add(a, Nat.add(r, o)), 0n) == True{} : Bool}
  {same(S.standing_of(a, r, b, o), S.Accepted{}) == Nat.is_ge(a, S.needed(Nat.add(a, Nat.add(r, o)))) : Bool}

law rejected_at_needed:
  for +a: Nat
  for +r: Nat
  for +b: Nat
  for +o: Nat
  for e: {Nat.is_gt(Nat.add(a, Nat.add(r, o)), 0n) == True{} : Bool}
  {same(S.standing_of(a, r, b, o), S.Rejected{}) == Nat.is_ge(r, S.needed(Nat.add(a, Nat.add(r, o)))) : Bool}

# 5. The table is the definition. Each standing is returned exactly when its
#    condition holds, and in review exactly when none does.
law not_started_is_its_row:
  for +a: Nat
  for +r: Nat
  for +b: Nat
  for +o: Nat
  {same(S.standing_of(a, r, b, o), S.NotStarted{}) == S.is_not_started(a, r, b) : Bool}

law accepted_is_its_row:
  for +a: Nat
  for +r: Nat
  for +b: Nat
  for +o: Nat
  {same(S.standing_of(a, r, b, o), S.Accepted{}) == S.is_accepted(a, r, o) : Bool}

law rejected_is_its_row:
  for +a: Nat
  for +r: Nat
  for +b: Nat
  for +o: Nat
  {same(S.standing_of(a, r, b, o), S.Rejected{}) == S.is_rejected(a, r, o) : Bool}

law no_quorum_is_its_row:
  for +a: Nat
  for +r: Nat
  for +b: Nat
  for +o: Nat
  {same(S.standing_of(a, r, b, o), S.NoQuorum{}) == S.is_no_quorum(a, r, b, o) : Bool}

law conflict_is_its_row:
  for +a: Nat
  for +r: Nat
  for +b: Nat
  for +o: Nat
  {same(S.standing_of(a, r, b, o), S.Conflict{}) == S.is_conflict(a, r, o) : Bool}

law in_review_is_no_row:
  for +a: Nat
  for +r: Nat
  for +b: Nat
  for +o: Nat
  {same(S.standing_of(a, r, b, o), S.InReview{}) == none(S.is_not_started(a, r, b), S.is_accepted(a, r, o), S.is_rejected(a, r, o), S.is_no_quorum(a, r, b, o), S.is_conflict(a, r, o)) : Bool}

# 6. Unopposed is never adverse. A tally with no reject and no abstention is
#    never conflict, rejected or no quorum, so turning every objection into an
#    accept clears an adverse standing (lib/review/simulate.ts relies on it).
law unopposed_is_never_adverse:
  for +a: Nat
  for +o: Nat
  {adverse(S.standing_of(a, 0n, 0n, o)) == False{} : Bool}

# 7. The settling point the page prints. needed_for, which lib/review/rules.ts
#    runs, is needed of the members who have not abstained, so laws 3 and 4
#    are about the number a reader sees.
law needed_for_is_needed:
  for +a: Nat
  for +r: Nat
  for +b: Nat
  for +o: Nat
  {S.needed_for(a, r, b, o) == S.needed(Nat.add(a, Nat.add(r, o))) : Nat}

# 8. The page's two numbers. "Settles at N of the M": N is needed of M, where
#    M is the count lib/review/rules.ts shows.
law needed_is_of_those_counted:
  for +a: Nat
  for +r: Nat
  for +b: Nat
  for +o: Nat
  {S.needed_for(a, r, b, o) == S.needed(S.not_abstaining(a, r, b, o)) : Nat}
