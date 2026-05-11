import { describe, it, expect } from "vitest";
import { moderateChat } from "./chat";

describe("moderateChat", () => {
  describe("accepts clean text", () => {
    it("returns ordinary messages unchanged", () => {
      expect(moderateChat("good game")).toBe("good game");
      expect(moderateChat("nice opening, what's the line called?")).toBe(
        "nice opening, what's the line called?"
      );
    });

    it("trims surrounding whitespace", () => {
      expect(moderateChat("  hi  ")).toBe("hi");
    });

    it("clamps to 200 chars without rejecting", () => {
      const long = "a".repeat(500);
      expect(moderateChat(long)).toBe("a".repeat(200));
    });
  });

  describe("rejects banned words", () => {
    it("blocks standalone profanity", () => {
      expect(moderateChat("fuck off")).toBeNull();
      expect(moderateChat("shit move")).toBeNull();
      expect(moderateChat("kys")).toBeNull();
    });

    it("blocks regardless of case", () => {
      expect(moderateChat("FUCK")).toBeNull();
      expect(moderateChat("Shit Move")).toBeNull();
    });

    it("blocks the multi-word entry as a phrase", () => {
      expect(moderateChat("just kill yourself")).toBeNull();
      expect(moderateChat("KILL YOURSELF now")).toBeNull();
    });

    // ── Inflection coverage ──────────────────────────────────────
    // Prefix-anchored entries should still catch the common
    // suffixes; a strict `\bword\b` would let "fucking" slip
    // through which is a meaningful gap for a chat banlist.
    it("blocks inflected forms of prefix-anchored entries", () => {
      expect(moderateChat("are you fucking kidding")).toBeNull();
      expect(moderateChat("what a fucker")).toBeNull();
      expect(moderateChat("that's shitty play")).toBeNull();
      expect(moderateChat("you bitches are tilted")).toBeNull();
      expect(moderateChat("retarded opening")).toBeNull();
      expect(moderateChat("you whores are tilted")).toBeNull();
    });
  });

  describe("does NOT false-positive on substrings", () => {
    // The Scunthorpe Problem and friends - banned words appearing
    // inside legitimate longer words used to be flagged by an
    // earlier .includes() implementation.
    it("does not flag names that happen to contain banned substrings", () => {
      expect(moderateChat("nice game, Dickens")).toBe("nice game, Dickens");
      expect(moderateChat("passenger")).toBe("passenger");
      expect(moderateChat("Scunthorpe is a real place")).toBe(
        "Scunthorpe is a real place"
      );
    });

    it("does not flag legitimate chess terminology", () => {
      // "Sicilian" doesn't have banned substrings, but check
      // "cocktail" / "Dickerson" / etc explicitly.
      expect(moderateChat("cocktail party")).toBe("cocktail party");
      expect(moderateChat("Mr. Dickerson plays the Sicilian")).toBe(
        "Mr. Dickerson plays the Sicilian"
      );
    });

    it("does not flag 'kill' or 'yourself' alone", () => {
      expect(moderateChat("you played a killer move")).toBe(
        "you played a killer move"
      );
      expect(moderateChat("you should think for yourself")).toBe(
        "you should think for yourself"
      );
    });

    // Strict-word entries (dick / cock / pussy) live in the
    // BAD_WORDS_STRICT list so their substrings inside common
    // English words don't trigger. These names show up enough
    // in real chess chatter (Dickerson, peacock openings, etc.)
    // that flagging them would be a real UX bug.
    it("does not flag legitimate words that start with strict-word entries", () => {
      expect(moderateChat("peacock variation")).toBe("peacock variation");
      expect(moderateChat("shuttlecock match")).toBe("shuttlecock match");
      expect(moderateChat("Hancock plays the Caro")).toBe(
        "Hancock plays the Caro"
      );
      expect(moderateChat("pussycat trap")).toBe("pussycat trap");
      expect(moderateChat("pussyfoot strategy")).toBe("pussyfoot strategy");
      expect(moderateChat("Dickson sacrificed")).toBe("Dickson sacrificed");
    });
  });

  describe("invalid inputs", () => {
    it("returns null for non-string", () => {
      expect(moderateChat(null)).toBeNull();
      expect(moderateChat(undefined)).toBeNull();
      expect(moderateChat(42)).toBeNull();
      expect(moderateChat({})).toBeNull();
    });

    it("returns null for empty / whitespace-only", () => {
      expect(moderateChat("")).toBeNull();
      expect(moderateChat("   ")).toBeNull();
      expect(moderateChat("\n\t")).toBeNull();
    });
  });
});
