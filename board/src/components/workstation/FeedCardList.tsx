"use client";

import { useState, useCallback } from "react";
import type { FeedCard, GapItem } from "./types";
import GovernanceFeed from "./GovernanceFeed";
import ChangeCard from "./cards/ChangeCard";
import AnswerCard from "./cards/AnswerCard";
import ResearchCard from "./cards/ResearchCard";
import IntakeCard from "./cards/IntakeCard";

interface FeedCardListProps {
  cards: FeedCard[];
  onIterate: (cardId: string, prompt: string) => void;
  onCreatePR: (cardId: string) => void;
  onDiscard: (cardId: string) => void;
  onCommitMessageChange: (cardId: string, message: string) => void;
  onFollowUp: (prompt: string) => void;
  onAddToSpec: (gap: GapItem) => void;
}

export default function FeedCardList({
  cards,
  onIterate,
  onCreatePR,
  onDiscard,
  onCommitMessageChange,
  onFollowUp,
  onAddToSpec,
}: FeedCardListProps) {
  const [expandedCardId, setExpandedCardId] = useState<string | null>(() => {
    // Auto-expand first non-done card
    const active = cards.find(
      (c) =>
        (c.type === "change" && c.stage !== "done") ||
        (c.type === "answer" && c.stage !== "answered") ||
        (c.type === "research" && c.stage !== "done") ||
        (c.type === "intake" && c.stage === "submitting")
    );
    return active?.id ?? cards[0]?.id ?? null;
  });

  const toggleCard = useCallback((id: string) => {
    setExpandedCardId((prev) => (prev === id ? null : id));
  }, []);

  // Auto-expand newly added cards (first card in array is newest)
  const firstCard = cards[0];
  if (firstCard && expandedCardId !== firstCard.id) {
    // Only auto-expand loading cards
    const isLoading =
      (firstCard.type === "change" && firstCard.stage === "loading") ||
      (firstCard.type === "answer" && firstCard.stage === "loading") ||
      (firstCard.type === "research" && (firstCard.stage === "loading" || firstCard.stage === "analyzing")) ||
      (firstCard.type === "intake" && firstCard.stage === "submitting");
    if (isLoading) {
      // Use a timeout-free check: if the card was just created (within last 500ms)
      if (Date.now() - firstCard.createdAt < 500) {
        setExpandedCardId(firstCard.id);
      }
    }
  }

  // Auto-expand the most recent card that has an error (any position, not just first)
  const errorCard = cards.find(
    (c) => "error" in c && c.error && expandedCardId !== c.id
  );
  if (errorCard) {
    setExpandedCardId(errorCard.id);
  }

  return (
    <div className="space-y-4">
      {/* Result cards — newest first */}
      {cards.map((card) => {
        const isExpanded = expandedCardId === card.id;

        switch (card.type) {
          case "change":
            return (
              <ChangeCard
                key={card.id}
                card={card}
                expanded={isExpanded}
                onToggle={() => toggleCard(card.id)}
                onIterate={onIterate}
                onCreatePR={onCreatePR}
                onDiscard={onDiscard}
                onCommitMessageChange={onCommitMessageChange}
              />
            );
          case "answer":
            return (
              <AnswerCard
                key={card.id}
                card={card}
                expanded={isExpanded}
                onToggle={() => toggleCard(card.id)}
                onFollowUp={onFollowUp}
              />
            );
          case "research":
            return (
              <ResearchCard
                key={card.id}
                card={card}
                expanded={isExpanded}
                onToggle={() => toggleCard(card.id)}
                onAddToSpec={onAddToSpec}
              />
            );
          case "intake":
            return (
              <IntakeCard
                key={card.id}
                card={card}
                expanded={isExpanded}
                onToggle={() => toggleCard(card.id)}
                onDiscard={onDiscard}
              />
            );
          default:
            return null;
        }
      })}

      {/* Governance feed — always at the bottom */}
      <GovernanceFeed />
    </div>
  );
}
