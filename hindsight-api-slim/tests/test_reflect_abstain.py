"""Reflect that may answer nothing (``abstain``), and searches the caller names (``search_queries``).

A memory watcher beside a coding agent asks reflect, at every step the agent takes, whether
memory has something the agent must hear. Most steps it has not, and the answer must then be
empty and cheap: no LLM call when the decision model already sees nothing that answers. These
tests pin the mechanics with a scripted provider; whether the decisions hold up is the evals' job.
"""

from unittest.mock import AsyncMock

import pytest

from hindsight_api.engine.cross_encoder import EvidencePick
from hindsight_api.engine.reflect.agent import ReflectNoAnswerError, run_reflect_agent
from hindsight_api.engine.response_models import LLMCallResult, LLMToolCall, LLMToolCallResult, TokenUsage
from tests.reflect_script import closing_echo


class _ScriptedProvider:
    """Answers ``call_with_tools`` from a script; records every call and what the closing call read."""

    def __init__(self, scripted: list[LLMToolCallResult], answer: str = "NONE"):
        self._reply = closing_echo(scripted)
        self.tool_choices: list[str] = []
        self.rewrites = 0
        self.last_messages: list[dict] = []
        self.answer = answer
        self.answer_prompts: list[str] = []

    async def call_with_tools(self, *, tool_choice, messages, **_):
        self.tool_choices.append(tool_choice.function_name or tool_choice.mode.value)
        self.last_messages = list(messages)
        return self._reply(tool_choice=tool_choice)

    async def call(self, *, messages, **_):
        prompt = messages[-1]["content"]
        if "## Memories" in prompt:  # the abstain answer, written from what was picked
            self.answer_prompts.append(prompt)
            return LLMCallResult(content=self.answer, usage=TokenUsage(input_tokens=1, output_tokens=1))
        self.rewrites += 1
        return LLMCallResult(content=prompt, usage=TokenUsage(input_tokens=1, output_tokens=1))


def _done(answer: str, found: bool = True) -> LLMToolCallResult:
    return LLMToolCallResult(
        tool_calls=[
            LLMToolCall(id="d", name="done", arguments={"answer": answer, "answer_found": found, "observation_ids": []})
        ],
        finish_reason="tool_calls",
    )


def _observations() -> AsyncMock:
    return AsyncMock(
        return_value={
            "observations": [
                {"id": "obs-rule", "text": "memory suffixes are binary: K=1024"},
                {"id": "obs-ci", "text": "CI runs on GitHub Actions"},
            ]
        }
    )


async def _reflect(provider, *, pick=None, prune=None, sufficient=None, search_observations=None, **kwargs):
    return await run_reflect_agent(
        llm_config=provider,
        bank_id="b",
        query="Does my change go against a recorded decision?",
        bank_profile={"name": "T", "mission": ""},
        search_mental_models_fn=AsyncMock(return_value={"mental_models": []}),
        read_mental_models_fn=AsyncMock(return_value={"mental_models": []}),
        search_observations_fn=search_observations or _observations(),
        recall_fn=AsyncMock(return_value={"memories": []}),
        expand_fn=AsyncMock(return_value={"memories": []}),
        has_mental_models=False,
        include_observations=True,
        include_recall=False,
        budget="low",
        max_iterations=4,
        evidence_is_sufficient_fn=sufficient or AsyncMock(return_value=True),
        prune_evidence_fn=prune or AsyncMock(side_effect=lambda q, texts: [1.0 - i / 10 for i in range(len(texts))]),
        pick_evidence_fn=pick,
        abstain=True,
        **kwargs,
    )


@pytest.mark.asyncio
async def test_nothing_answers_returns_empty_with_no_llm_call():
    provider = _ScriptedProvider([])
    pick = AsyncMock(return_value=EvidencePick(none=0.97, candidates=[0.02, 0.01]))

    result = await _reflect(provider, pick=pick)

    assert result.abstained and result.text == ""
    assert provider.tool_choices == [] and provider.rewrites == 1, "only the search rewrite ran"


@pytest.mark.asyncio
async def test_the_answer_reads_only_what_the_decision_model_picked():
    provider = _ScriptedProvider([], answer="Memory suffixes are binary: K=1024.")
    pick = AsyncMock(return_value=EvidencePick(none=0.2, candidates=[0.78, 0.02]))

    result = await _reflect(provider, pick=pick)

    assert not result.abstained and result.text == "Memory suffixes are binary: K=1024."
    assert result.used_observation_ids == ["obs-rule"], "the note cites the memory it came from"
    (prompt,) = provider.answer_prompts
    assert "K=1024" in prompt and "GitHub Actions" not in prompt, "an unpicked memory never reaches the answer"
    assert provider.tool_choices == [], "one short call, not the agent's closing turn"
    assert [c.scope for c in result.llm_trace] == ["round_query", "decision_pick", "abstain_answer"]


@pytest.mark.asyncio
async def test_the_pick_is_asked_the_question_about_the_context_over_each_searchs_best():
    provider = _ScriptedProvider([])
    # Every search returns the same memories, each in its own order (a bank's whole observation set).
    junk, rule, other = ({"id": i, "text": t} for i, t in (("j", "release notes"), ("r", "units rule"), ("o", "CI")))
    by_query = {
        "boilerplate": {"observations": [junk, other, rule]},
        "units": {"observations": [rule, junk, other]},
    }
    search = AsyncMock(side_effect=lambda q, *a, **k: by_query[q])
    pick = AsyncMock(return_value=EvidencePick(none=0.95, candidates=[0.02, 0.02, 0.01]))

    await _reflect(
        provider,
        pick=pick,
        search_observations=search,
        search_queries=["boilerplate", "units"],
        context="I edited units.py",
    )

    question, context, offered = pick.await_args.args
    assert question == "Does my change go against a recorded decision?" and context == "I edited units.py"
    assert offered == ["release notes", "units rule", "CI"], "each search's best first, in turn, each memory once"


@pytest.mark.asyncio
async def test_an_answer_of_none_is_silence_not_text():
    """Below the bar the LLM decides; its NONE is an empty answer, not prose."""
    provider = _ScriptedProvider([], answer="NONE")
    pick = AsyncMock(return_value=EvidencePick(none=0.6, candidates=[0.35, 0.05]))

    result = await _reflect(provider, pick=pick)

    assert result.abstained and result.text == ""


@pytest.mark.asyncio
async def test_a_done_reporting_nothing_found_returns_empty_instead_of_text():
    """Without a pick the agent's closing turn answers; its "nothing found" is silence too."""
    provider = _ScriptedProvider([_done("Nothing conflicts: your change follows the decision.", found=False)])

    result = await _reflect(provider, sufficient=AsyncMock(return_value=True))

    assert result.abstained and result.text == ""


@pytest.mark.asyncio
async def test_without_a_pick_not_enough_returns_empty_instead_of_searching_on():
    provider = _ScriptedProvider([])

    result = await _reflect(provider, sufficient=AsyncMock(return_value=False))

    assert result.abstained and result.text == ""
    assert provider.tool_choices == [], "no follow-up LLM turn"


@pytest.mark.asyncio
async def test_an_empty_done_without_abstain_still_fails():
    """The pre-existing contract (#2959): an answer that is not there is an error unless asked for."""
    provider = _ScriptedProvider([_done("")])
    with pytest.raises(ReflectNoAnswerError):
        await run_reflect_agent(
            llm_config=provider,
            bank_id="b",
            query="q",
            bank_profile={"name": "T", "mission": ""},
            search_mental_models_fn=AsyncMock(return_value={"mental_models": []}),
            read_mental_models_fn=AsyncMock(return_value={"mental_models": []}),
            search_observations_fn=_observations(),
            recall_fn=AsyncMock(return_value={"memories": []}),
            expand_fn=AsyncMock(return_value={"memories": []}),
            has_mental_models=False,
            include_recall=False,
            budget="low",
            max_iterations=3,
            evidence_is_sufficient_fn=AsyncMock(return_value=True),
        )


@pytest.mark.asyncio
async def test_search_queries_replace_the_rewrite_and_each_runs():
    provider = _ScriptedProvider([])
    search = _observations()
    pick = AsyncMock(return_value=EvidencePick(none=0.99, candidates=[0.0, 0.0]))

    await _reflect(provider, pick=pick, search_observations=search, search_queries=["parse_quantity units", "disk GB"])

    assert provider.rewrites == 0, "no LLM call before the search"
    assert [c.args[0] for c in search.await_args_list] == ["parse_quantity units", "disk GB"]
    # Both queries returned the same two observations: the pick sees each once.
    _, _, offered = pick.await_args.args
    assert len(offered) == 2


@pytest.mark.asyncio
async def test_a_failed_pick_falls_back_to_the_sufficiency_check():
    provider = _ScriptedProvider([])
    pick = AsyncMock(side_effect=RuntimeError("HTTP 500"))

    result = await _reflect(provider, pick=pick, sufficient=AsyncMock(return_value=False))

    assert result.abstained, "the sufficiency check still decides, and abstains on not enough"
