# Bouncer: Background and Research Goals

## Project Vision

Our goal for the "Bouncer" project is to experiment with *some amount* of automation for permission requests in coding agents: in other words, a **policy bot** for enabling safe but convenient workflows with coding agents.

The *ideal* would be to identify classes of common coding use cases where the policy bot can automate away 100% of the need for human permission requests with 0% false negatives (i.e., cases where the policy bot allows the coding agent to do an operation that turns out to have been unsafe). But this may not be an achievable goal.

A *good result* would be one where we can implement a policy automation that automates away *some* permission requests with 0% false nmegatives.

In other words, our **top priority** is safety; our **secondary priority** is automating unnecessary permission requests.

## Project Principles

The following principles should guide our experiments:

**Sandboxing is useless without policy**: There are many sandboxing technologies that can be used to provide strong guarantees about what an agent does and doesn't have access to, both low-level (containers, hypervisors, network proxies, etc) as well as a new crop of agent sandboxing technologies that have been in the news. But to some degree "sandboxing" as a solution for agent automation simply begs the question. The hardest part of the problem is defining the model of safety: what constitutes unsafe/unacceptable agent behavior? In other words, we need to identify useful policies.

**There is low-hanging fruit everywhere**: There may be some brilliant "theory of everything" that gets us to the ideal outcome, and maybe we won't be the ones to find it. But that doesn't mean we can't make things better. The perfect is the enemy of progress. If we can identify *some* safe patterns and automate them, we can build a tool that make semi-autonomous (human-in-the-loop) agent experiences much more efficient, even if we can't get them to fully autonomous. And the default experience of most coding agents is that agents are extremely conservative and repetitive about asking the user's permission. There is a lot we can do to make this better without losing safety.

**Both deterministic and non-deterministic solutions are on the table**: Using an LLM as a judge for safety policies sounds a little scary, but if it can be constrained enough to be predictable, an LLM may be more adaptable to minor but benign syntactic variations in tool use requests than deterministic policy specifications, which may end up being too rigid and brittle to handle the natural variations in real-world tool use. We should be willing to explore both deterministic and non-deterministic heuristics, and hybrid solutions as well.

**Constraining scope improves our chances of success.** We don't need to create one single policy that fits all use cases. We can constrain the scope of policies to particular kinds of activities, which makes the problem easier and allows us to deliver value without having all the answers to all situations.

**We will learn how to apply and combine policies over time.** Over the long-term, we may find that we are collecting a library of different policies for different situations. We will learn as we go how to identify which policies, or combinations of policies, are appropriate for which situations, and we may in turn learn how to automate some of those decisions. We don't need to solve all of these problems yet. Again, progress over perfection!

## Research Goals

We already have a small corpus of my personal session histories with Claude Code on this device. I have documented some information about [how to analyze Claude Code session history](../../reference/claude-code-history-analysis.md). I would like to start our experiments with an investigation of real data from these session histories to start to build a framework for how to categorize patterns of tool use requests and begin to develop some hypotheses for how we could go about developing an MVP of a policy bot for some small but useful subset of them.

The output of this research phase should be a few artifacts:

- A decision about what subset we will go after first.
- A draft of how to characterize the safety / unsafety model for this subset.
- A hypothesis about an implementation strategy (e.g. deterministic vs non-deterministic vs hybrid mechanisms for classifying tool use patterns to characterize as safe vs unsafe).
- A dataset synthesized from the raw history data in my session history, which we can use as input for a test suite.
