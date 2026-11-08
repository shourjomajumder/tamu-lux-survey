"""Shared route helpers: turn-by-turn steps in the iPhone app's SurveyRoute step shape, place names.

Used by route_library.py (original + recheck loops) and new_routes.py (new-path routes).
"""
import math


def bearing(p, q):
    return math.degrees(math.atan2(q[0] - p[0], q[1] - p[1])) % 360


def make_steps(P, cum, names_at, finish="Back at the start — route complete"):
    """P: [(x, y)] metres, cum: cumulative metres, names_at((x, y)) -> path name or ''."""
    steps = []
    hd = [bearing(P[k], P[k + 1]) for k in range(len(P) - 1)]
    turns = [0]
    for k in range(1, len(hd)):
        # look ~10 m back/ahead for a stable heading change
        a = hd[max(0, k - 2)]; b = hd[min(len(hd) - 1, k + 2)]
        t = ((b - a + 540) % 360) - 180
        if abs(t) > 40 and cum[k] - cum[turns[-1]] > 15: turns.append(k)
    turns.append(len(P) - 1)
    for n, (k, k2) in enumerate(zip(turns, turns[1:])):
        if n == 0: icon, verb = "start", "Start"
        else:
            a = hd[max(0, k - 2)]; b = hd[min(len(hd) - 1, k + 2)]; t = ((b - a + 540) % 360) - 180
            icon, verb = ("uturn", "Turn around") if abs(t) > 150 else (("right", "Turn right") if t > 0 else ("left", "Turn left"))
            if 40 < abs(t) <= 70: icon, verb = ("slight-right", "Bear right") if t > 0 else ("slight-left", "Bear left")
        nm = names_at(P[k])
        txt = f"{verb}{' on ' + nm if nm else ''}"
        steps.append(dict(i=n + 1, txt=txt, hint="", icon=icon, at=round(cum[k], 1), L=round(cum[k2] - cum[k], 1), rep=False))
    steps.append(dict(i=len(steps) + 1, txt=finish, hint="", icon="finish", at=round(cum[-1], 1), L=0.0, rep=False))
    return steps
