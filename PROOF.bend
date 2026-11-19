# The proofs of LAWS.bend. Each law there is proved here by the def named
# Laws.<law>; `deno task bend:check` is the gate, and it prints ALL PROOFS
# CHECK only while every law holds of lib/review/standing.bend as it is
# written now. Nothing here runs: lib/review/rules.ts never imports this file.
#
# Bend has no tactics. A proof is a def whose type is the claim: a `match`
# splits the cases and computes the claim in each, a recursive call is the
# induction hypothesis, `{==}` closes a claim whose two sides compute to the
# same term, and `%e : P` rewrites the claim with the equation e, `_` in P
# marking where. A proof is a value like any other and is used at most once.
#
# A def may only call the ones above it, so the file goes lemmas first, and
# the laws in the order they lean on one another: law 2 (exclusive rows), law 5
# (the table is the definition), law 1 (finality), law 3 (needed), law 4 (the
# settling point), law 6 (unopposed is never adverse), law 7 (the settling
# point the page prints).
#
# a, r, b, o: the members accepting, rejecting, abstaining and outstanding.

import Base
import ./lib/review/standing.bend as S
import ./LAWS.bend as Laws

# ---------------------------------------------------------------------------
# Truth. A condition of the table is a Bool, and a fact about one is the
# equation saying it is True, or False.
#
# In a case that cannot happen a premise computes to {False == True}. Where the
# claim computes to that same equation the premise is returned as it is;
# elsewhere ft_empty and Empty.absurd turn it into the claim.
# ---------------------------------------------------------------------------

def Holds(b: Bool) -> Type:
  {b == True{} : Bool}

def Fails(b: Bool) -> Type:
  {b == False{} : Bool}

def IsTrue(b: Bool) -> Type:
  match b:
    case False{}:
      Empty
    case True{}:
      Unit

# False is not True.
def ft_empty(e: {False{} == True{} : Bool}) -> Empty:
  %Equal.sym(Bool, False{}, True{}, e) : IsTrue(_)
  Unit{}

# True is not False.
def tf_empty(e: {True{} == False{} : Bool}) -> Empty:
  %e : IsTrue(_)
  Unit{}

# The first half of a conjunction that holds.
def and_fst(x: Bool, y: Bool, e: Holds(Bool.and(x, y))) -> Holds(x):
  match x:
    case False{}:
      e
    case True{}:
      {==}

# The second half of a conjunction that holds.
def and_snd(x: Bool, y: Bool, e: Holds(Bool.and(x, y))) -> Holds(y):
  match x:
    case False{}:
      Empty.absurd(Holds(y), ft_empty(e))
    case True{}:
      e

# Two conditions that hold make a conjunction that holds.
def and_join(x: Bool, y: Bool, ex: Holds(x), ey: Holds(y)) -> Holds(Bool.and(x, y)):
  match x:
    case False{}:
      ex
    case True{}:
      ey

# A conjunction that holds, carried half by half to another. A proof is used
# once, so the two halves cannot be taken out of e one after the other.
def and_map(x: Bool, y: Bool, x2: Bool, y2: Bool,
    f: Holds(x) -> Holds(x2), g: Holds(y) -> Holds(y2),
    e: Holds(Bool.and(x, y))) -> Holds(Bool.and(x2, y2)):
  match x y:
    case False{} _:
      Empty.absurd(Holds(Bool.and(x2, y2)), ft_empty(e))
    case True{} False{}:
      Empty.absurd(Holds(Bool.and(x2, y2)), ft_empty(e))
    case True{} True{}:
      and_join(x2, y2, f({==}), g({==}))

# A conjunction ending in False is False, whatever comes first.
def and_false_r(x: Bool) -> Fails(Bool.and(x, False{})):
  match x:
    case False{}:
      {==}
    case True{}:
      {==}

# The same, three conditions deep.
def and_false_3(x: Bool, y: Bool, z: Bool) -> Fails(Bool.and(x, Bool.and(y, Bool.and(z, False{})))):
  match x y z:
    case False{} _ _:
      {==}
    case True{} False{} _:
      {==}
    case True{} True{} False{}:
      {==}
    case True{} True{} True{}:
      {==}

# Two conditions that cannot both hold have a False conjunction.
def never_both(x: Bool, y: Bool, f: Holds(x) -> Holds(y) -> Empty) -> Fails(Bool.and(x, y)):
  match x y:
    case False{} _:
      {==}
    case True{} False{}:
      {==}
    case True{} True{}:
      Empty.absurd(Fails(True{}), f({==}, {==}))

# A condition y that excludes x is unchanged by "not x, and y".
def absorb(x: Bool, y: Bool, e: Fails(Bool.and(x, y))) -> {Bool.and(Bool.not(x), y) == y : Bool}:
  match x y:
    case False{} _:
      {==}
    case True{} False{}:
      {==}
    case True{} True{}:
      Equal.sym(Bool, True{}, False{}, e)

# ---------------------------------------------------------------------------
# Order on Nat.
# ---------------------------------------------------------------------------

# a >= 0.
def ge_zero(a: Nat) -> Holds(Nat.is_ge(a, 0n)):
  match a:
    case 0n:
      {==}
    case 1n+p:
      {==}

# a >= 1 + d gives a >= d.
def ge_weaken(a: Nat, d: Nat, e: Holds(Nat.is_ge(a, 1n+d))) -> Holds(Nat.is_ge(a, d)):
  match a d:
    case 0n 0n:
      {==}
    case 0n 1n+dp:
      e
    case 1n+ap 0n:
      {==}
    case 1n+ap 1n+dp:
      ge_weaken(ap, dp, e)

# a >= d gives 1 + a >= d.
def ge_step(a: Nat, d: Nat, e: Holds(Nat.is_ge(a, d))) -> Holds(Nat.is_ge(1n+a, d)):
  match a d:
    case 0n 0n:
      {==}
    case 0n 1n+dp:
      Empty.absurd(Holds(Nat.is_ge(1n, 1n+dp)), ft_empty(e))
    case 1n+ap 0n:
      {==}
    case 1n+ap 1n+dp:
      ge_step(ap, dp, e)

# a >= b and b >= c give a >= c.
def ge_trans(a: Nat, b: Nat, c: Nat,
    ab: Holds(Nat.is_ge(a, b)), bc: Holds(Nat.is_ge(b, c))) -> Holds(Nat.is_ge(a, c)):
  match a b c:
    case 0n 0n 0n:
      {==}
    case 0n 0n 1n+cp:
      bc
    case 0n 1n+bp 0n:
      {==}
    case 0n 1n+bp 1n+cp:
      ab
    case 1n+ap 0n 0n:
      {==}
    case 1n+ap 0n 1n+cp:
      Empty.absurd(Holds(Nat.is_ge(1n+ap, 1n+cp)), ft_empty(bc))
    case 1n+ap 1n+bp 0n:
      {==}
    case 1n+ap 1n+bp 1n+cp:
      ge_trans(ap, bp, cp, ab, bc)

# x + y >= x.
def ge_add_r(x: Nat, +y: Nat) -> Holds(Nat.is_ge(Nat.add(x, y), x)):
  match x:
    case 0n:
      ge_zero(y)
    case 1n+p:
      ge_add_r(p, y)

# 2x >= x.
def double_ge(+x: Nat) -> Holds(Nat.is_ge(Nat.double(x), x)):
  match x:
    case 0n:
      {==}
    case 1n+p:
      ge_step(Nat.double(p), p, double_ge(p))

# x >= y gives 2x >= 2y.
def double_mono(x: Nat, y: Nat, e: Holds(Nat.is_ge(x, y))) -> Holds(Nat.is_ge(Nat.double(x), Nat.double(y))):
  match x y:
    case 0n 0n:
      {==}
    case 0n 1n+yp:
      e
    case 1n+xp 0n:
      {==}
    case 1n+xp 1n+yp:
      double_mono(xp, yp, e)

# x >= 2(y + o) gives x >= 2y.
def ge_double_drop(+x: Nat, +y: Nat, +o: Nat,
    e: Holds(Nat.is_ge(x, Nat.double(Nat.add(y, o))))) -> Holds(Nat.is_ge(x, Nat.double(y))):
  ge_trans(x, Nat.double(Nat.add(y, o)), Nat.double(y), e, double_mono(Nat.add(y, o), y, ge_add_r(y, o)))

# p >= 1 + 2p never holds.
def no_ge_succ_double(+p: Nat, e: Holds(Nat.is_ge(p, 1n+Nat.double(p)))) -> Empty:
  match p:
    case 0n:
      ft_empty(e)
    case 1n+q:
      no_ge_succ_double(q, ge_weaken(q, 1n+Nat.double(q), e))

# A comparison is not both "less" and "at least".
def cmp_clash(c: Cmp, lt: Holds(Cmp.is_lt(c)), ge: Holds(Cmp.is_ge(c))) -> Empty:
  match c:
    case LT{}:
      ft_empty(ge)
    case EQ{}:
      ft_empty(lt)
    case GT{}:
      ft_empty(lt)

# x < y and x >= y never hold together.
def lt_ge_clash(x: Nat, y: Nat, lt: Holds(Nat.is_lt(x, y)), ge: Holds(Nat.is_ge(x, y))) -> Empty:
  cmp_clash(Nat.cmp(x, y), lt, ge)

# 1 + x < y gives x < y.
def lt_pred(x: Nat, y: Nat, e: Holds(Nat.is_lt(1n+x, y))) -> Holds(Nat.is_lt(x, y)):
  match x y:
    case 0n 0n:
      e
    case 0n 1n+yp:
      {==}
    case 1n+xp 0n:
      e
    case 1n+xp 1n+yp:
      lt_pred(xp, yp, e)

# x < y gives x < 1 + y.
def lt_grow(x: Nat, y: Nat, e: Holds(Nat.is_lt(x, y))) -> Holds(Nat.is_lt(x, 1n+y)):
  match x y:
    case 0n 0n:
      {==}
    case 0n 1n+yp:
      {==}
    case 1n+xp 0n:
      Empty.absurd(Holds(Nat.is_lt(1n+xp, 1n)), ft_empty(e))
    case 1n+xp 1n+yp:
      lt_grow(xp, yp, e)

# ---------------------------------------------------------------------------
# Sums. Nat.add recurses on its first argument, so a successor on the second
# does not compute out: these equations move it.
# ---------------------------------------------------------------------------

# a + (1 + b) is 1 + (a + b).
def add_succ_r(a: Nat, +b: Nat) -> {Nat.add(a, 1n+b) == 1n+Nat.add(a, b) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+p:
      %add_succ_r(p, b) : {1n+Nat.add(p, 1n+b) == 1n+_ : Nat}
      {==}

# The same equation read the other way, for a rewrite in the other direction.
def succ_add_r(+a: Nat, +b: Nat) -> {1n+Nat.add(a, b) == Nat.add(a, 1n+b) : Nat}:
  Equal.sym(Nat, Nat.add(a, 1n+b), 1n+Nat.add(a, b), add_succ_r(a, b))

# 2 + (a + b) is a + (2 + b).
def add_two_r(a: Nat, +b: Nat) -> {2n+Nat.add(a, b) == Nat.add(a, 2n+b) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+p:
      %add_two_r(p, b) : {3n+Nat.add(p, b) == 1n+_ : Nat}
      {==}

# a is a + 0.
def add_zero_r(a: Nat) -> {a == Nat.add(a, 0n) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+p:
      %add_zero_r(p) : {1n+p == 1n+_ : Nat}
      {==}

# r + (a + o) is a + (r + o).
def add_swap(+a: Nat, +r: Nat, +o: Nat) -> {Nat.add(r, Nat.add(a, o)) == Nat.add(a, Nat.add(r, o)) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+p:
      %add_swap(p, r, o) : {Nat.add(r, 1n+Nat.add(p, o)) == 1n+_ : Nat}
      add_succ_r(r, Nat.add(p, o))

# ---------------------------------------------------------------------------
# The five conditions, pair by pair: no tally satisfies two of them. Seven of
# the ten pairs disagree on which count is zero and close by computing; the
# three among accepted, rejected and conflict are the arithmetic of two thirds.
# ---------------------------------------------------------------------------

# An accepted tally has acc >= 2(rej + out). A rejected one too, with the two
# counts exchanged: is_rejected(a, r, o) unfolds to is_accepted(r, a, o).
def acc_ge(x: Nat, y: Nat, o: Nat, e: Holds(S.is_accepted(x, y, o))) -> Holds(Nat.is_ge(x, Nat.double(Nat.add(y, o)))):
  match x:
    case 0n:
      Empty.absurd(Holds(Nat.is_ge(0n, Nat.double(Nat.add(y, o)))), ft_empty(e))
    case 1n+p:
      e

# Accepted and rejected: a >= 2r and r >= 2a leave a >= 2a, so a = 0, and an
# accepted tally has an accept.
def acc_rej_clash(+a: Nat, +r: Nat, +o: Nat,
    ea: Holds(S.is_accepted(a, r, o)), er: Holds(S.is_rejected(a, r, o))) -> Empty:
  match a:
    case 0n:
      ft_empty(ea)
    case 1n+p:
      no_ge_succ_double(p,
        ge_trans(1n+p, Nat.double(r), Nat.double(1n+p),
          ge_double_drop(1n+p, r, o, ea),
          ge_trans(Nat.double(r), r, Nat.double(1n+p),
            double_ge(r),
            ge_double_drop(r, 1n+p, o, acc_ge(r, 1n+p, o, er)))))

# Accepted and conflict: a >= 2(r + o) gives a + o >= 2r, and a conflict has
# a + o < 2r.
def acc_con_clash(+a: Nat, +r: Nat, +o: Nat,
    ea: Holds(S.is_accepted(a, r, o)), ec: Holds(S.is_conflict(a, r, o))) -> Empty:
  lt_ge_clash(Nat.add(a, o), Nat.double(r),
    and_fst(Nat.is_lt(Nat.add(a, o), Nat.double(r)), Nat.is_lt(Nat.add(r, o), Nat.double(a)), ec),
    ge_trans(Nat.add(a, o), a, Nat.double(r),
      ge_add_r(a, o),
      ge_double_drop(a, r, o, acc_ge(a, r, o, ea))))

# Rejected and conflict: the same with the two counts exchanged, against the
# conflict's other half, r + o < 2a.
def rej_con_clash(+a: Nat, +r: Nat, +o: Nat,
    er: Holds(S.is_rejected(a, r, o)), ec: Holds(S.is_conflict(a, r, o))) -> Empty:
  lt_ge_clash(Nat.add(r, o), Nat.double(a),
    and_snd(Nat.is_lt(Nat.add(a, o), Nat.double(r)), Nat.is_lt(Nat.add(r, o), Nat.double(a)), ec),
    ge_trans(Nat.add(r, o), r, Nat.double(a),
      ge_add_r(r, o),
      ge_double_drop(r, a, o, acc_ge(r, a, o, er))))

# Not started and accepted: no answer at all, and an accept.
def ns_acc(+a: Nat, +r: Nat, +b: Nat, +o: Nat) -> Fails(Bool.and(S.is_not_started(a, r, b), S.is_accepted(a, r, o))):
  match a:
    case 0n:
      and_false_r(Nat.is_eq(Nat.add(r, b), 0n))
    case 1n+p:
      {==}

# Not started and rejected: no answer at all, and a reject.
def ns_rej(+a: Nat, +r: Nat, +b: Nat, +o: Nat) -> Fails(Bool.and(S.is_not_started(a, r, b), S.is_rejected(a, r, o))):
  match a r:
    case 0n 0n:
      and_false_r(Nat.is_eq(b, 0n))
    case 0n 1n+q:
      {==}
    case 1n+p _:
      {==}

# Not started and no quorum: no answer at all, and an abstention.
def ns_nq(+a: Nat, +r: Nat, +b: Nat, +o: Nat) -> Fails(Bool.and(S.is_not_started(a, r, b), S.is_no_quorum(a, r, b, o))):
  match a r b:
    case 0n 0n 0n:
      {==}
    case 0n 0n 1n+bp:
      {==}
    case 0n 1n+q _:
      {==}
    case 1n+p _ _:
      {==}

# Not started and conflict: with no accept and no reject, a conflict would
# need out < 0.
def ns_con(+a: Nat, +r: Nat, +b: Nat, +o: Nat) -> Fails(Bool.and(S.is_not_started(a, r, b), S.is_conflict(a, r, o))):
  match a r o:
    case 0n 0n 0n:
      and_false_r(Nat.is_eq(b, 0n))
    case 0n 0n 1n+op:
      and_false_r(Nat.is_eq(b, 0n))
    case 0n 1n+q _:
      {==}
    case 1n+p _ _:
      {==}

# Accepted and rejected.
def acc_rej(+a: Nat, +r: Nat, +o: Nat) -> Fails(Bool.and(S.is_accepted(a, r, o), S.is_rejected(a, r, o))):
  never_both(S.is_accepted(a, r, o), S.is_rejected(a, r, o), acc_rej_clash(a, r, o))

# Accepted and no quorum: an accept, and nobody but abstainers.
def acc_nq(+a: Nat, +r: Nat, +b: Nat, +o: Nat) -> Fails(Bool.and(S.is_accepted(a, r, o), S.is_no_quorum(a, r, b, o))):
  match a:
    case 0n:
      {==}
    case 1n+p:
      and_false_3(S.is_accepted(1n+p, r, o), Nat.is_gt(b, 0n), Nat.is_eq(o, 0n))

# Accepted and conflict.
def acc_con(+a: Nat, +r: Nat, +o: Nat) -> Fails(Bool.and(S.is_accepted(a, r, o), S.is_conflict(a, r, o))):
  never_both(S.is_accepted(a, r, o), S.is_conflict(a, r, o), acc_con_clash(a, r, o))

# Rejected and no quorum: a reject, and nobody but abstainers.
def rej_nq(+a: Nat, +r: Nat, +b: Nat, +o: Nat) -> Fails(Bool.and(S.is_rejected(a, r, o), S.is_no_quorum(a, r, b, o))):
  match a r:
    case 0n 0n:
      {==}
    case 0n 1n+q:
      and_false_3(S.is_rejected(0n, 1n+q, o), Nat.is_gt(b, 0n), Nat.is_eq(o, 0n))
    case 1n+p _:
      and_false_3(S.is_rejected(1n+p, r, o), Nat.is_gt(b, 0n), Nat.is_eq(o, 0n))

# Rejected and conflict.
def rej_con(+a: Nat, +r: Nat, +o: Nat) -> Fails(Bool.and(S.is_rejected(a, r, o), S.is_conflict(a, r, o))):
  never_both(S.is_rejected(a, r, o), S.is_conflict(a, r, o), rej_con_clash(a, r, o))

# No quorum and conflict: with nobody but abstainers, a conflict would need
# 0 < 0.
def nq_con(+a: Nat, +r: Nat, +b: Nat, +o: Nat) -> Fails(Bool.and(S.is_no_quorum(a, r, b, o), S.is_conflict(a, r, o))):
  match a r b o:
    case _ _ 0n _:
      {==}
    case _ _ 1n+bp 1n+op:
      {==}
    case 0n 0n 1n+bp 0n:
      {==}
    case 0n 1n+q 1n+bp 0n:
      {==}
    case 1n+p _ 1n+bp 0n:
      {==}

# ---------------------------------------------------------------------------
# Law 2. Exclusive rows.
# ---------------------------------------------------------------------------

# Five conditions that exclude one another pair by pair: at most one is True.
def at_most_one_of_pairs(p: Bool, q: Bool, s: Bool, t: Bool, u: Bool,
    pq: Fails(Bool.and(p, q)), ps: Fails(Bool.and(p, s)), pt: Fails(Bool.and(p, t)), pu: Fails(Bool.and(p, u)),
    qs: Fails(Bool.and(q, s)), qt: Fails(Bool.and(q, t)), qu: Fails(Bool.and(q, u)),
    st: Fails(Bool.and(s, t)), su: Fails(Bool.and(s, u)),
    tu: Fails(Bool.and(t, u))) -> Holds(Laws.at_most_one(p, q, s, t, u)):
  match p q s t u:
    case False{} False{} False{} False{} _:
      {==}
    case False{} False{} False{} True{} False{}:
      {==}
    case False{} False{} False{} True{} True{}:
      Empty.absurd(Holds(False{}), tf_empty(tu))
    case False{} False{} True{} False{} False{}:
      {==}
    case False{} False{} True{} False{} True{}:
      Empty.absurd(Holds(False{}), tf_empty(su))
    case False{} False{} True{} True{} _:
      Empty.absurd(Holds(False{}), tf_empty(st))
    case False{} True{} False{} False{} False{}:
      {==}
    case False{} True{} False{} False{} True{}:
      Empty.absurd(Holds(False{}), tf_empty(qu))
    case False{} True{} False{} True{} _:
      Empty.absurd(Holds(False{}), tf_empty(qt))
    case False{} True{} True{} _ _:
      Empty.absurd(Holds(False{}), tf_empty(qs))
    case True{} False{} False{} False{} False{}:
      {==}
    case True{} False{} False{} False{} True{}:
      Empty.absurd(Holds(False{}), tf_empty(pu))
    case True{} False{} False{} True{} _:
      Empty.absurd(Holds(False{}), tf_empty(pt))
    case True{} False{} True{} _ _:
      Empty.absurd(Holds(False{}), tf_empty(ps))
    case True{} True{} _ _ _:
      Empty.absurd(Holds(False{}), tf_empty(pq))

def Laws.rows_exclusive(a, r, b, o):
  at_most_one_of_pairs(
    S.is_not_started(a, r, b), S.is_accepted(a, r, o), S.is_rejected(a, r, o),
    S.is_no_quorum(a, r, b, o), S.is_conflict(a, r, o),
    ns_acc(a, r, b, o), ns_rej(a, r, b, o), ns_nq(a, r, b, o), ns_con(a, r, b, o),
    acc_rej(a, r, o), acc_nq(a, r, b, o), acc_con(a, r, o),
    rej_nq(a, r, b, o), rej_con(a, r, o),
    nq_con(a, r, b, o))

# ---------------------------------------------------------------------------
# Law 5. The table is the definition.
#
# pick answers with the first row whose condition is True, so a row is
# returned when its condition holds and no earlier one does (first_*). The
# exclusions above then remove the earlier ones (*_row).
# ---------------------------------------------------------------------------

# pick answers NotStarted exactly when the first condition is True.
def first_not_started(p: Bool, q: Bool, s: Bool, t: Bool, u: Bool) -> {
    Laws.same(S.pick(p, q, s, t, u), S.NotStarted{}) == p : Bool}:
  match p q s t u:
    case False{} False{} False{} False{} False{}:
      {==}
    case False{} False{} False{} False{} True{}:
      {==}
    case False{} False{} False{} True{} _:
      {==}
    case False{} False{} True{} _ _:
      {==}
    case False{} True{} _ _ _:
      {==}
    case True{} _ _ _ _:
      {==}

# pick answers Accepted exactly when the second is the first True.
def first_accepted(p: Bool, q: Bool, s: Bool, t: Bool, u: Bool) -> {
    Laws.same(S.pick(p, q, s, t, u), S.Accepted{}) == Bool.and(Bool.not(p), q) : Bool}:
  match p q s t u:
    case False{} False{} False{} False{} False{}:
      {==}
    case False{} False{} False{} False{} True{}:
      {==}
    case False{} False{} False{} True{} _:
      {==}
    case False{} False{} True{} _ _:
      {==}
    case False{} True{} _ _ _:
      {==}
    case True{} _ _ _ _:
      {==}

# pick answers Rejected exactly when the third is the first True.
def first_rejected(p: Bool, q: Bool, s: Bool, t: Bool, u: Bool) -> {
    Laws.same(S.pick(p, q, s, t, u), S.Rejected{}) == Bool.and(Bool.not(p), Bool.and(Bool.not(q), s)) : Bool}:
  match p q s t u:
    case False{} False{} False{} False{} False{}:
      {==}
    case False{} False{} False{} False{} True{}:
      {==}
    case False{} False{} False{} True{} _:
      {==}
    case False{} False{} True{} _ _:
      {==}
    case False{} True{} _ _ _:
      {==}
    case True{} _ _ _ _:
      {==}

# pick answers NoQuorum exactly when the fourth is the first True.
def first_no_quorum(p: Bool, q: Bool, s: Bool, t: Bool, u: Bool) -> {
    Laws.same(S.pick(p, q, s, t, u), S.NoQuorum{})
    == Bool.and(Bool.not(p), Bool.and(Bool.not(q), Bool.and(Bool.not(s), t))) : Bool}:
  match p q s t u:
    case False{} False{} False{} False{} False{}:
      {==}
    case False{} False{} False{} False{} True{}:
      {==}
    case False{} False{} False{} True{} _:
      {==}
    case False{} False{} True{} _ _:
      {==}
    case False{} True{} _ _ _:
      {==}
    case True{} _ _ _ _:
      {==}

# pick answers Conflict exactly when the fifth is the first True.
def first_conflict(p: Bool, q: Bool, s: Bool, t: Bool, u: Bool) -> {
    Laws.same(S.pick(p, q, s, t, u), S.Conflict{})
    == Bool.and(Bool.not(p), Bool.and(Bool.not(q), Bool.and(Bool.not(s), Bool.and(Bool.not(t), u)))) : Bool}:
  match p q s t u:
    case False{} False{} False{} False{} False{}:
      {==}
    case False{} False{} False{} False{} True{}:
      {==}
    case False{} False{} False{} True{} _:
      {==}
    case False{} False{} True{} _ _:
      {==}
    case False{} True{} _ _ _:
      {==}
    case True{} _ _ _ _:
      {==}

# pick answers InReview exactly when none of the five is True.
def first_in_review(p: Bool, q: Bool, s: Bool, t: Bool, u: Bool) -> {
    Laws.same(S.pick(p, q, s, t, u), S.InReview{}) == Laws.none(p, q, s, t, u) : Bool}:
  match p q s t u:
    case False{} False{} False{} False{} False{}:
      {==}
    case False{} False{} False{} False{} True{}:
      {==}
    case False{} False{} False{} True{} _:
      {==}
    case False{} False{} True{} _ _:
      {==}
    case False{} True{} _ _ _:
      {==}
    case True{} _ _ _ _:
      {==}

# With the exclusions, "and no earlier one" goes: a row is returned exactly
# when its own condition is True. One rewrite per earlier row, the first row
# first, each turning the bare condition into "not that row, and" it.

def accepted_row(+p: Bool, +q: Bool, +s: Bool, +t: Bool, +u: Bool,
    pq: Fails(Bool.and(p, q))) -> {Laws.same(S.pick(p, q, s, t, u), S.Accepted{}) == q : Bool}:
  %absorb(p, q, pq) : {Laws.same(S.pick(p, q, s, t, u), S.Accepted{}) == _ : Bool}
  first_accepted(p, q, s, t, u)

def rejected_row(+p: Bool, +q: Bool, +s: Bool, +t: Bool, +u: Bool,
    ps: Fails(Bool.and(p, s)), qs: Fails(Bool.and(q, s))) -> {
    Laws.same(S.pick(p, q, s, t, u), S.Rejected{}) == s : Bool}:
  %absorb(p, s, ps) : {Laws.same(S.pick(p, q, s, t, u), S.Rejected{}) == _ : Bool}
  %absorb(q, s, qs) : {Laws.same(S.pick(p, q, s, t, u), S.Rejected{}) == Bool.and(Bool.not(p), _) : Bool}
  first_rejected(p, q, s, t, u)

def no_quorum_row(+p: Bool, +q: Bool, +s: Bool, +t: Bool, +u: Bool,
    pt: Fails(Bool.and(p, t)), qt: Fails(Bool.and(q, t)), st: Fails(Bool.and(s, t))) -> {
    Laws.same(S.pick(p, q, s, t, u), S.NoQuorum{}) == t : Bool}:
  %absorb(p, t, pt) : {Laws.same(S.pick(p, q, s, t, u), S.NoQuorum{}) == _ : Bool}
  %absorb(q, t, qt) : {Laws.same(S.pick(p, q, s, t, u), S.NoQuorum{}) == Bool.and(Bool.not(p), _) : Bool}
  %absorb(s, t, st) : {Laws.same(S.pick(p, q, s, t, u), S.NoQuorum{})
    == Bool.and(Bool.not(p), Bool.and(Bool.not(q), _)) : Bool}
  first_no_quorum(p, q, s, t, u)

def conflict_row(+p: Bool, +q: Bool, +s: Bool, +t: Bool, +u: Bool,
    pu: Fails(Bool.and(p, u)), qu: Fails(Bool.and(q, u)), su: Fails(Bool.and(s, u)), tu: Fails(Bool.and(t, u))) -> {
    Laws.same(S.pick(p, q, s, t, u), S.Conflict{}) == u : Bool}:
  %absorb(p, u, pu) : {Laws.same(S.pick(p, q, s, t, u), S.Conflict{}) == _ : Bool}
  %absorb(q, u, qu) : {Laws.same(S.pick(p, q, s, t, u), S.Conflict{}) == Bool.and(Bool.not(p), _) : Bool}
  %absorb(s, u, su) : {Laws.same(S.pick(p, q, s, t, u), S.Conflict{})
    == Bool.and(Bool.not(p), Bool.and(Bool.not(q), _)) : Bool}
  %absorb(t, u, tu) : {Laws.same(S.pick(p, q, s, t, u), S.Conflict{})
    == Bool.and(Bool.not(p), Bool.and(Bool.not(q), Bool.and(Bool.not(s), _))) : Bool}
  first_conflict(p, q, s, t, u)

def Laws.not_started_is_its_row(a, r, b, o):
  first_not_started(
    S.is_not_started(a, r, b), S.is_accepted(a, r, o), S.is_rejected(a, r, o),
    S.is_no_quorum(a, r, b, o), S.is_conflict(a, r, o))

def Laws.accepted_is_its_row(a, r, b, o):
  accepted_row(
    S.is_not_started(a, r, b), S.is_accepted(a, r, o), S.is_rejected(a, r, o),
    S.is_no_quorum(a, r, b, o), S.is_conflict(a, r, o),
    ns_acc(a, r, b, o))

def Laws.rejected_is_its_row(a, r, b, o):
  rejected_row(
    S.is_not_started(a, r, b), S.is_accepted(a, r, o), S.is_rejected(a, r, o),
    S.is_no_quorum(a, r, b, o), S.is_conflict(a, r, o),
    ns_rej(a, r, b, o), acc_rej(a, r, o))

def Laws.no_quorum_is_its_row(a, r, b, o):
  no_quorum_row(
    S.is_not_started(a, r, b), S.is_accepted(a, r, o), S.is_rejected(a, r, o),
    S.is_no_quorum(a, r, b, o), S.is_conflict(a, r, o),
    ns_nq(a, r, b, o), acc_nq(a, r, b, o), rej_nq(a, r, b, o))

def Laws.conflict_is_its_row(a, r, b, o):
  conflict_row(
    S.is_not_started(a, r, b), S.is_accepted(a, r, o), S.is_rejected(a, r, o),
    S.is_no_quorum(a, r, b, o), S.is_conflict(a, r, o),
    ns_con(a, r, b, o), acc_con(a, r, o), rej_con(a, r, o), nq_con(a, r, b, o))

def Laws.in_review_is_no_row(a, r, b, o):
  first_in_review(
    S.is_not_started(a, r, b), S.is_accepted(a, r, o), S.is_rejected(a, r, o),
    S.is_no_quorum(a, r, b, o), S.is_conflict(a, r, o))

# ---------------------------------------------------------------------------
# Law 1. Finality.
#
# By law 5 a tally has a settled standing exactly when that standing's
# condition holds, so each finality law is a fact about one condition: it
# still holds once an outstanding member has answered.
# ---------------------------------------------------------------------------

# Every standing is the same as itself.
def same_refl(k: S.Standing) -> Holds(Laws.same(k, k)):
  match k:
    case S.NotStarted{}:
      {==}
    case S.InReview{}:
      {==}
    case S.Conflict{}:
      {==}
    case S.Accepted{}:
      {==}
    case S.Rejected{}:
      {==}
    case S.NoQuorum{}:
      {==}

# A standing that `same` calls Accepted is Accepted.
def same_accepted(x: S.Standing, e: Holds(Laws.same(x, S.Accepted{}))) -> {x == S.Accepted{} : S.Standing}:
  match x:
    case S.NotStarted{}:
      Empty.absurd({S.NotStarted{} == S.Accepted{} : S.Standing}, ft_empty(e))
    case S.InReview{}:
      Empty.absurd({S.InReview{} == S.Accepted{} : S.Standing}, ft_empty(e))
    case S.Conflict{}:
      Empty.absurd({S.Conflict{} == S.Accepted{} : S.Standing}, ft_empty(e))
    case S.Accepted{}:
      {==}
    case S.Rejected{}:
      Empty.absurd({S.Rejected{} == S.Accepted{} : S.Standing}, ft_empty(e))
    case S.NoQuorum{}:
      Empty.absurd({S.NoQuorum{} == S.Accepted{} : S.Standing}, ft_empty(e))

# A standing that `same` calls Rejected is Rejected.
def same_rejected(x: S.Standing, e: Holds(Laws.same(x, S.Rejected{}))) -> {x == S.Rejected{} : S.Standing}:
  match x:
    case S.NotStarted{}:
      Empty.absurd({S.NotStarted{} == S.Rejected{} : S.Standing}, ft_empty(e))
    case S.InReview{}:
      Empty.absurd({S.InReview{} == S.Rejected{} : S.Standing}, ft_empty(e))
    case S.Conflict{}:
      Empty.absurd({S.Conflict{} == S.Rejected{} : S.Standing}, ft_empty(e))
    case S.Accepted{}:
      Empty.absurd({S.Accepted{} == S.Rejected{} : S.Standing}, ft_empty(e))
    case S.Rejected{}:
      {==}
    case S.NoQuorum{}:
      Empty.absurd({S.NoQuorum{} == S.Rejected{} : S.Standing}, ft_empty(e))

# A standing that `same` calls Conflict is Conflict.
def same_conflict(x: S.Standing, e: Holds(Laws.same(x, S.Conflict{}))) -> {x == S.Conflict{} : S.Standing}:
  match x:
    case S.NotStarted{}:
      Empty.absurd({S.NotStarted{} == S.Conflict{} : S.Standing}, ft_empty(e))
    case S.InReview{}:
      Empty.absurd({S.InReview{} == S.Conflict{} : S.Standing}, ft_empty(e))
    case S.Conflict{}:
      {==}
    case S.Accepted{}:
      Empty.absurd({S.Accepted{} == S.Conflict{} : S.Standing}, ft_empty(e))
    case S.Rejected{}:
      Empty.absurd({S.Rejected{} == S.Conflict{} : S.Standing}, ft_empty(e))
    case S.NoQuorum{}:
      Empty.absurd({S.NoQuorum{} == S.Conflict{} : S.Standing}, ft_empty(e))

# From a standing to its condition: x is k, and x is k exactly when c, so c.
def row_out(-x: S.Standing, k: S.Standing, -c: Bool,
    row: {Laws.same(x, k) == c : Bool}, e: {x == k : S.Standing}) -> Holds(c):
  %row : {_ == True{} : Bool}
  %Equal.sym(S.Standing, x, k, e) : {Laws.same(_, k) == True{} : Bool}
  same_refl(k)

# From a condition to `same`: x is k exactly when c, and c holds.
def row_in(-x: S.Standing, -k: S.Standing, -c: Bool,
    row: {Laws.same(x, k) == c : Bool}, e: Holds(c)) -> Holds(Laws.same(x, k)):
  Equal.trans(Bool, Laws.same(x, k), c, True{}, row, e)

# An accepted tally satisfies the accepted condition.
def accepted_out(+a: Nat, +r: Nat, +b: Nat, +o: Nat,
    e: {S.standing_of(a, r, b, o) == S.Accepted{} : S.Standing}) -> Holds(S.is_accepted(a, r, o)):
  row_out(S.standing_of(a, r, b, o), S.Accepted{}, S.is_accepted(a, r, o),
    Laws.accepted_is_its_row(a, r, b, o), e)

# A tally satisfying the accepted condition is accepted.
def accepted_in(+a: Nat, +r: Nat, +b: Nat, +o: Nat,
    e: Holds(S.is_accepted(a, r, o))) -> {S.standing_of(a, r, b, o) == S.Accepted{} : S.Standing}:
  same_accepted(S.standing_of(a, r, b, o),
    row_in(S.standing_of(a, r, b, o), S.Accepted{}, S.is_accepted(a, r, o),
      Laws.accepted_is_its_row(a, r, b, o), e))

# A rejected tally satisfies the rejected condition.
def rejected_out(+a: Nat, +r: Nat, +b: Nat, +o: Nat,
    e: {S.standing_of(a, r, b, o) == S.Rejected{} : S.Standing}) -> Holds(S.is_rejected(a, r, o)):
  row_out(S.standing_of(a, r, b, o), S.Rejected{}, S.is_rejected(a, r, o),
    Laws.rejected_is_its_row(a, r, b, o), e)

# A tally satisfying the rejected condition is rejected.
def rejected_in(+a: Nat, +r: Nat, +b: Nat, +o: Nat,
    e: Holds(S.is_rejected(a, r, o))) -> {S.standing_of(a, r, b, o) == S.Rejected{} : S.Standing}:
  same_rejected(S.standing_of(a, r, b, o),
    row_in(S.standing_of(a, r, b, o), S.Rejected{}, S.is_rejected(a, r, o),
      Laws.rejected_is_its_row(a, r, b, o), e))

# A tally in conflict satisfies the conflict condition.
def conflict_out(+a: Nat, +r: Nat, +b: Nat, +o: Nat,
    e: {S.standing_of(a, r, b, o) == S.Conflict{} : S.Standing}) -> Holds(S.is_conflict(a, r, o)):
  row_out(S.standing_of(a, r, b, o), S.Conflict{}, S.is_conflict(a, r, o),
    Laws.conflict_is_its_row(a, r, b, o), e)

# A tally satisfying the conflict condition is in conflict.
def conflict_in(+a: Nat, +r: Nat, +b: Nat, +o: Nat,
    e: Holds(S.is_conflict(a, r, o))) -> {S.standing_of(a, r, b, o) == S.Conflict{} : S.Standing}:
  same_conflict(S.standing_of(a, r, b, o),
    row_in(S.standing_of(a, r, b, o), S.Conflict{}, S.is_conflict(a, r, o),
      Laws.conflict_is_its_row(a, r, b, o), e))

# The accepted condition, is_accepted(x, y, o), is x > 0 and x >= 2(y + o).
# The rejected condition is the same def with the two counts exchanged, so the
# three lemmas below serve both: x is the side that has two thirds, y the
# other.

# x >= 2(y + (1 + o)) is x >= 2 + 2(y + o).
def ge_out_moved(x: Nat, +y: Nat, +o: Nat,
    e: Holds(Nat.is_ge(x, Nat.double(Nat.add(y, 1n+o))))) -> Holds(Nat.is_ge(x, 2n+Nat.double(Nat.add(y, o)))):
  %add_succ_r(y, o) : Holds(Nat.is_ge(x, Nat.double(_)))
  e

# The outstanding member abstains: x >= 2 + 2(y + o) gives x >= 2(y + o).
def acc_abstains(+x: Nat, +y: Nat, +o: Nat, e: Holds(S.is_accepted(x, y, 1n+o))) -> Holds(S.is_accepted(x, y, o)):
  match x:
    case 0n:
      e
    case 1n+p:
      ge_weaken(1n+p, Nat.double(Nat.add(y, o)),
        ge_weaken(1n+p, 1n+Nat.double(Nat.add(y, o)),
          ge_out_moved(1n+p, y, o, e)))

# The outstanding member sides with x: then 1 + x >= 2(y + o) as well.
def acc_gains(+x: Nat, +y: Nat, +o: Nat, e: Holds(S.is_accepted(x, y, 1n+o))) -> Holds(S.is_accepted(1n+x, y, o)):
  ge_step(x, Nat.double(Nat.add(y, o)), acc_ge(x, y, o, acc_abstains(x, y, o, e)))

# The outstanding member sides with y: 2((1 + y) + o) is the same 2 + 2(y + o).
def acc_loses(+x: Nat, +y: Nat, +o: Nat, e: Holds(S.is_accepted(x, y, 1n+o))) -> Holds(S.is_accepted(x, 1n+y, o)):
  match x:
    case 0n:
      e
    case 1n+p:
      ge_out_moved(1n+p, y, o, e)

def Laws.accepted_final_accept(a, r, b, o, e):
  accepted_in(1n+a, r, b, o, acc_gains(a, r, o, accepted_out(a, r, b, 1n+o, e)))

def Laws.accepted_final_reject(a, r, b, o, e):
  accepted_in(a, 1n+r, b, o, acc_loses(a, r, o, accepted_out(a, r, b, 1n+o, e)))

def Laws.accepted_final_abstain(a, r, b, o, e):
  accepted_in(a, r, 1n+b, o, acc_abstains(a, r, o, accepted_out(a, r, b, 1n+o, e)))

def Laws.rejected_final_accept(a, r, b, o, e):
  rejected_in(1n+a, r, b, o, acc_loses(r, a, o, rejected_out(a, r, b, 1n+o, e)))

def Laws.rejected_final_reject(a, r, b, o, e):
  rejected_in(a, 1n+r, b, o, acc_gains(r, a, o, rejected_out(a, r, b, 1n+o, e)))

def Laws.rejected_final_abstain(a, r, b, o, e):
  rejected_in(a, r, 1n+b, o, acc_abstains(r, a, o, rejected_out(a, r, b, 1n+o, e)))

# The conflict condition is two halves of one shape, x + o < 2y: even with
# every outstanding member, x stays under twice y. is_conflict(a, r, o) unfolds
# to under(a, o, r) and under(r, o, a).
def under(x: Nat, o: Nat, y: Nat) -> Bool:
  Nat.is_lt(Nat.add(x, o), Nat.double(y))

# The outstanding member sides with x: x + (1 + o) is (1 + x) + o.
def under_gains(x: Nat, +o: Nat, y: Nat, e: Holds(under(x, 1n+o, y))) -> Holds(under(1n+x, o, y)):
  %add_succ_r(x, o) : Holds(Nat.is_lt(_, Nat.double(y)))
  e

# The outstanding member abstains: x + o is one less.
def under_abstains(+x: Nat, +o: Nat, +y: Nat, e: Holds(under(x, 1n+o, y))) -> Holds(under(x, o, y)):
  lt_pred(Nat.add(x, o), Nat.double(y), under_gains(x, o, y, e))

# The outstanding member sides with y: x + o is one less, and 2y two more.
def under_loses(+x: Nat, +o: Nat, +y: Nat, e: Holds(under(x, 1n+o, y))) -> Holds(under(x, o, 1n+y)):
  lt_grow(Nat.add(x, o), 1n+Nat.double(y),
    lt_grow(Nat.add(x, o), Nat.double(y),
      under_abstains(x, o, y, e)))

# A conflict stays one when the outstanding member accepts.
def con_accepts(+a: Nat, +r: Nat, +o: Nat, e: Holds(S.is_conflict(a, r, 1n+o))) -> Holds(S.is_conflict(1n+a, r, o)):
  and_map(under(a, 1n+o, r), under(r, 1n+o, a), under(1n+a, o, r), under(r, o, 1n+a),
    under_gains(a, o, r), under_loses(r, o, a), e)

# A conflict stays one when the outstanding member rejects.
def con_rejects(+a: Nat, +r: Nat, +o: Nat, e: Holds(S.is_conflict(a, r, 1n+o))) -> Holds(S.is_conflict(a, 1n+r, o)):
  and_map(under(a, 1n+o, r), under(r, 1n+o, a), under(a, o, 1n+r), under(1n+r, o, a),
    under_loses(a, o, r), under_gains(r, o, a), e)

# A conflict stays one when the outstanding member abstains.
def con_abstains(+a: Nat, +r: Nat, +o: Nat, e: Holds(S.is_conflict(a, r, 1n+o))) -> Holds(S.is_conflict(a, r, o)):
  and_map(under(a, 1n+o, r), under(r, 1n+o, a), under(a, o, r), under(r, o, a),
    under_abstains(a, o, r), under_abstains(r, o, a), e)

def Laws.conflict_final_accept(a, r, b, o, e):
  conflict_in(1n+a, r, b, o, con_accepts(a, r, o, conflict_out(a, r, b, 1n+o, e)))

def Laws.conflict_final_reject(a, r, b, o, e):
  conflict_in(a, 1n+r, b, o, con_rejects(a, r, o, conflict_out(a, r, b, 1n+o, e)))

def Laws.conflict_final_abstain(a, r, b, o, e):
  conflict_in(a, r, 1n+b, o, con_abstains(a, r, o, conflict_out(a, r, b, 1n+o, e)))

# ---------------------------------------------------------------------------
# Law 3. Needed is two thirds, rounded up.
#
# needed goes up by two for every three more members, so both laws are an
# induction three members at a time: 3 * needed gains six, and so does 2n.
# ---------------------------------------------------------------------------

# 3(2 + m) is 6 + 3m. Nat.mul(3n, x) unfolds to x + (x + (x + 0)), and each
# rewrite moves one 2 out of a second argument.
def mul3_step(+m: Nat) -> {6n+Nat.mul(3n, m) == Nat.mul(3n, 2n+m) : Nat}:
  %add_two_r(m, Nat.add(m, 0n)) : {6n+Nat.mul(3n, m) == 2n+Nat.add(m, 2n+_) : Nat}
  %add_two_r(m, 2n+Nat.mul(2n, m)) : {6n+Nat.mul(3n, m) == 2n+_ : Nat}
  %add_two_r(m, Nat.mul(2n, m)) : {6n+Nat.mul(3n, m) == 4n+_ : Nat}
  {==}

def Laws.needed_reaches_two_thirds(n):
  match n:
    case 0n:
      {==}
    case 1n:
      {==}
    case 2n:
      {==}
    case 3n+p:
      %mul3_step(S.needed(p)) : {Nat.is_ge(_, Nat.double(3n+p)) == True{} : Bool}
      Laws.needed_reaches_two_thirds(p)

def Laws.needed_is_least(n):
  match n:
    case 0n:
      {==}
    case 1n:
      {==}
    case 2n:
      {==}
    case 3n+p:
      %mul3_step(S.needed(p)) : {Nat.is_lt(_, Nat.add(Nat.double(3n+p), 3n)) == True{} : Bool}
      Laws.needed_is_least(p)

# ---------------------------------------------------------------------------
# Law 4. Settling point.
#
# Of the x + k members who have not abstained, x >= 2k says the same as
# x >= needed(x + k). Two more for x and one more for k leave both sides as
# they were, which is the induction.
# ---------------------------------------------------------------------------

# n >= needed(n).
def needed_le(+n: Nat) -> Holds(Nat.is_ge(n, S.needed(n))):
  match n:
    case 0n:
      {==}
    case 1n:
      {==}
    case 2n:
      {==}
    case 3n+p:
      ge_step(p, S.needed(p), needed_le(p))

# Of at least one member, at least one is needed: 0 >= needed(k) is False.
def needed_pos(k: Nat, e: Holds(Nat.is_gt(k, 0n))) -> {False{} == Nat.is_ge(0n, S.needed(k)) : Bool}:
  match k:
    case 0n:
      e
    case 1n:
      {==}
    case 2n:
      {==}
    case 3n+p:
      {==}

# x >= 2k exactly when x >= needed(x + k).
def settles(+x: Nat, +k: Nat) -> {Nat.is_ge(x, Nat.double(k)) == Nat.is_ge(x, S.needed(Nat.add(x, k))) : Bool}:
  match x k:
    case 0n 0n:
      {==}
    case 0n 1n+kp:
      needed_pos(1n+kp, {==})
    case 1n 0n:
      {==}
    case 1n 1n:
      {==}
    case 1n 2n+kp:
      {==}
    case 2n+xp 0n:
      %add_zero_r(xp) : {True{} == Nat.is_ge(2n+xp, S.needed(2n+_)) : Bool}
      Equal.sym(Bool, Nat.is_ge(2n+xp, S.needed(2n+xp)), True{}, needed_le(2n+xp))
    case 2n+xp 1n+kp:
      %succ_add_r(xp, kp) : {Nat.is_ge(xp, Nat.double(kp)) == Nat.is_ge(2n+xp, S.needed(2n+_)) : Bool}
      settles(xp, kp)

# The accepted condition is x >= needed, once someone has not abstained. The
# rejected one too, with the two counts exchanged.
def acc_settles(+x: Nat, +y: Nat, +o: Nat, e: Holds(Nat.is_gt(Nat.add(x, Nat.add(y, o)), 0n))) -> {
    S.is_accepted(x, y, o) == Nat.is_ge(x, S.needed(Nat.add(x, Nat.add(y, o)))) : Bool}:
  match x:
    case 0n:
      needed_pos(Nat.add(y, o), e)
    case 1n+p:
      settles(1n+p, Nat.add(y, o))

def Laws.accepted_at_needed(a, r, b, o, e):
  Equal.trans(Bool,
    Laws.same(S.standing_of(a, r, b, o), S.Accepted{}),
    S.is_accepted(a, r, o),
    Nat.is_ge(a, S.needed(Nat.add(a, Nat.add(r, o)))),
    Laws.accepted_is_its_row(a, r, b, o),
    acc_settles(a, r, o, e))

# The law's premise with the accepts and the rejects exchanged.
def some_answer_swap(+a: Nat, +r: Nat, +o: Nat,
    e: Holds(Nat.is_gt(Nat.add(a, Nat.add(r, o)), 0n))) -> Holds(Nat.is_gt(Nat.add(r, Nat.add(a, o)), 0n)):
  %add_swap(r, a, o) : Holds(Nat.is_gt(_, 0n))
  e

def Laws.rejected_at_needed(a, r, b, o, e):
  %add_swap(a, r, o) : {Laws.same(S.standing_of(a, r, b, o), S.Rejected{}) == Nat.is_ge(r, S.needed(_)) : Bool}
  Equal.trans(Bool,
    Laws.same(S.standing_of(a, r, b, o), S.Rejected{}),
    S.is_rejected(a, r, o),
    Nat.is_ge(r, S.needed(Nat.add(r, Nat.add(a, o)))),
    Laws.rejected_is_its_row(a, r, b, o),
    acc_settles(r, a, o, some_answer_swap(a, r, o, e)))

# ---------------------------------------------------------------------------
# Law 6. Unopposed is never adverse.
#
# With no reject and no abstention the rejected, no-quorum and conflict
# conditions all compute to False, so pick is left with not started, accepted
# or in review.
# ---------------------------------------------------------------------------

# With the last three conditions False, pick's answer is not adverse.
def unopposed_pick(ns: Bool, acc: Bool) -> Fails(Laws.adverse(S.pick(ns, acc, False{}, False{}, False{}))):
  match ns acc:
    case True{} True{}:
      {==}
    case True{} False{}:
      {==}
    case False{} True{}:
      {==}
    case False{} False{}:
      {==}

def Laws.unopposed_is_never_adverse(a, o):
  match a:
    case 0n:
      {==}
    case 1n+p:
      unopposed_pick(False{}, Nat.is_ge(1n+p, Nat.double(o)))

# ---------------------------------------------------------------------------
# Law 7. The settling point the page prints.
#
# needed_from carries a running total where needed adds two on the way back,
# so needed_from(n, k) is needed(n) + k: an induction three members at a time,
# like law 3's, with the total left free so that the induction hypothesis can
# be taken at two more. The law is the case k = 0.
# ---------------------------------------------------------------------------

# needed(n) + k is needed_from(n, k).
def needed_from_adds(+n: Nat, +k: Nat) -> {Nat.add(S.needed(n), k) == S.needed_from(n, k) : Nat}:
  match n:
    case 0n:
      {==}
    case 1n:
      {==}
    case 2n:
      {==}
    case 3n+p:
      %needed_from_adds(p, 2n+k) : {2n+Nat.add(S.needed(p), k) == _ : Nat}
      add_two_r(S.needed(p), k)

def Laws.needed_for_is_needed(a, r, b, o):
  %needed_from_adds(Nat.add(a, Nat.add(r, o)), 0n) : {_ == S.needed(Nat.add(a, Nat.add(r, o))) : Nat}
  %add_zero_r(S.needed(Nat.add(a, Nat.add(r, o)))) : {_ == S.needed(Nat.add(a, Nat.add(r, o))) : Nat}
  {==}
