import { useMemo } from "react";
import { useParams, Link } from "react-router-dom";

/**
 * Legal pages: Privacy, Terms, Attribution.
 *
 * One component, three slugs, content authored as plain JSX so we
 * don't need a markdown renderer dependency. The text below is
 * deliberately written to match what the live database actually
 * stores (see `supabase/schema.sql`) — every claim about data
 * collection, retention, and deletion is grounded in a real table
 * or RLS policy.
 *
 * Effective date is set at the bottom of each document and should be
 * bumped whenever the policy materially changes. Do NOT edit the
 * effective date silently for cosmetic edits.
 */

const EFFECTIVE_DATE = "April 27, 2026";
const CONTACT_EMAIL = "ijtihedk@gmail.com";
// oChess is run by a single individual based in Helsinki, Finland.
// Finnish law governs use of the service.
const JURISDICTION = "Finland";
const OPERATOR = "an individual operator based in Helsinki, Finland";

const PAGES = {
  privacy: { title: "Privacy", slug: "privacy" },
  terms: { title: "Terms", slug: "terms" },
  attribution: { title: "Attribution", slug: "attribution" },
};

export default function LegalPage() {
  const { slug } = useParams();
  const meta = PAGES[slug];

  if (!meta) {
    return (
      <div className="min-h-[calc(100dvh-4rem)] flex flex-col items-center justify-center px-6 text-center">
        <span className="font-label text-[10px] uppercase tracking-[0.3em] text-on-surface-variant/30 mb-4">404</span>
        <h2 className="font-headline text-3xl sm:text-4xl font-extrabold tracking-tighter text-primary mb-3">
          Legal section not found
        </h2>
        <p className="text-sm text-on-surface-variant/40 max-w-xs mb-8">
          Try one of <Link className="underline" to="/legal/privacy">Privacy</Link>,{" "}
          <Link className="underline" to="/legal/terms">Terms</Link>, or{" "}
          <Link className="underline" to="/legal/attribution">Attribution</Link>.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-[760px] mx-auto px-5 sm:px-6 md:px-10 pt-16 pb-20">
      <div className="anim-fade-up">
        <span className="font-label text-[10px] uppercase tracking-[0.3em] text-on-surface-variant/30">
          Legal
        </span>
        <h1 className="font-headline text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tighter text-primary mt-2">
          {meta.title}
        </h1>
      </div>

      <nav className="anim-fade-up mt-6 mb-12 flex flex-wrap gap-1.5 text-[11px]" style={{ "--delay": "0.05s" }}>
        {Object.values(PAGES).map((p) => (
          <Link
            key={p.slug}
            to={`/legal/${p.slug}`}
            className={`px-3 py-1.5 border ${
              p.slug === slug
                ? "border-primary/40 text-primary"
                : "border-white/[0.06] text-on-surface-variant/55 hover:text-primary"
            } font-headline uppercase tracking-wide font-bold transition-colors`}
          >
            {p.title}
          </Link>
        ))}
      </nav>

      <article className="anim-fade-up text-[13px] leading-relaxed text-on-surface-variant/75 space-y-5" style={{ "--delay": "0.1s" }}>
        {slug === "privacy" && <PrivacyContent />}
        {slug === "terms" && <TermsContent />}
        {slug === "attribution" && <AttributionContent />}
      </article>

      <p className="mt-12 text-[10px] uppercase tracking-widest text-on-surface-variant/25">
        Effective {EFFECTIVE_DATE}
      </p>
    </div>
  );
}

const H2 = ({ children }) => (
  <h2 className="font-headline text-base font-extrabold uppercase tracking-wide text-primary mt-8 mb-2">{children}</h2>
);
const H3 = ({ children }) => (
  <h3 className="font-headline text-[12px] font-bold uppercase tracking-widest text-on-surface-variant/55 mt-5 mb-1.5">{children}</h3>
);
const Code = ({ children }) => (
  <code className="font-mono text-[11px] text-primary/80 bg-white/[0.04] px-1 py-0.5 rounded-sm">{children}</code>
);

function PrivacyContent() {
  return (
    <>
      <p>
        oChess is a chess platform run as an open-source project. This page
        describes what personal data the service collects, where it lives, who
        else sees it, and how to remove it. We have written it to match the
        actual database schema rather than a generic template — every field
        named below corresponds to a real column you can read from the source
        in <Code>supabase/schema.sql</Code>.
      </p>

      <H2>What we collect</H2>

      <H3>Account credentials</H3>
      <p>
        When you create an account, Supabase Auth stores your email address and
        a salted password hash. If you sign in with Google, the OAuth provider
        returns your email and (optionally) display name and avatar URL — these
        are forwarded to Supabase and used to seed your profile row. We never
        see or store your raw password.
      </p>

      <H3>Profile information you provide</H3>
      <p>
        Your row in the <Code>profiles</Code> table holds: <Code>username</Code>,{" "}
        <Code>display_name</Code>, <Code>avatar_url</Code>, <Code>bio</Code>,{" "}
        <Code>country</Code>, <Code>lichess_username</Code>,{" "}
        <Code>chesscom_username</Code>, your saved board preferences, and the
        timestamps when the row was created and last updated. All of these are
        publicly readable so other players can find you and view your profile;
        only you can write to them.
      </p>

      <H3>Game and rating history</H3>
      <p>
        Each completed game is stored in the <Code>games</Code> table with the
        full move list (<Code>pgn</Code>), result, time control, variant,
        ratings before and after, in-game chat, and start / end timestamps.
        Active games hold the same data while play is ongoing. Rating numbers
        themselves live in the <Code>ratings</Code> table and are computed by
        the Glicko-2 algorithm at the end of each rated game.
      </p>
      <p>
        Game rows are visible to both participants while the game is active,
        and visible to everyone once the game completes. This is intentional —
        the post-game review and analysis surfaces depend on a public PGN.
      </p>

      <H3>Matchmaking and challenges</H3>
      <p>
        While you wait for an opponent, a <Code>seeks</Code> row stores your
        user id, username, rating, and time-control preferences so other
        players can match against you. Stale seeks are deleted automatically
        every 5 minutes by a scheduled <Code>pg_cron</Code> job. Challenge
        links go into the <Code>challenges</Code> table; rows are deleted or
        marked expired when the link is consumed.
      </p>

      <H3>Puzzles and review</H3>
      <p>
        Your puzzle rating, daily-puzzle progress, and individual puzzle
        attempts are stored in <Code>puzzle_progress</Code> and{" "}
        <Code>puzzle_attempts</Code>. Review cards (spaced-repetition entries
        you save from failed puzzles or important game positions) are stored
        in <Code>review_cards</Code> with the FEN, your answer, and the SM-2
        scheduling fields. All three tables are private — only you can read or
        write your own rows.
      </p>

      <H3>Social graph</H3>
      <p>
        Friend relationships are stored in the <Code>friendships</Code> table
        with the two user ids and the request status. A row is visible only
        to the two participants.
      </p>

      <H3>Avatar uploads</H3>
      <p>
        If you upload an avatar, the image file is stored in the public{" "}
        <Code>avatars</Code> Supabase Storage bucket, namespaced under your
        user id. Anyone can read the file via its URL; only you can write,
        update, or delete files in your folder.
      </p>

      <H3>Browser-only data</H3>
      <p>
        Some state never leaves your device: bot game saves, puzzle history,
        review cards (in guest mode), board preferences, and the guest-mode
        flag are stored in your browser&apos;s <Code>localStorage</Code>.
        Clearing site data removes all of this and we cannot recover it.
      </p>

      <H3>What we do not collect</H3>
      <p>
        We do not run analytics, advertising, behavioural tracking, or
        third-party fingerprinting scripts. There is no telemetry call from
        the client beyond what is required to play (Supabase Realtime,
        Supabase Postgres, your own browser&apos;s WebSocket to the chess
        engine worker).
      </p>

      <H2>How we use it</H2>
      <p>
        We use the data above only to provide the service — authenticating
        you, matching you against opponents, computing ratings, displaying
        your profile, persisting saved games and puzzles, and propagating
        moves between you and your opponents in real time. We do not sell or
        rent personal data, and we do not share it with third parties for
        marketing.
      </p>

      <H2>Third parties</H2>
      <p>
        <strong>Supabase</strong> hosts the database, authentication, storage,
        and Realtime subsystems. They process the data above on our behalf.
        See <a className="underline" href="https://supabase.com/privacy" target="_blank" rel="noopener noreferrer">supabase.com/privacy</a>.
      </p>
      <p>
        <strong>Google</strong> is involved only if you sign in with Google.
        See <a className="underline" href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">policies.google.com/privacy</a>.
      </p>
      <p>
        <strong>Lichess and chess.com</strong> are contacted only when you
        explicitly use the &quot;Import games&quot; feature on your profile.
        Your browser fetches your public games directly from those services;
        we do not proxy or persist the request.
      </p>
      <p>
        <strong>Stockfish</strong> runs entirely inside your browser as a
        WebAssembly worker. No position is ever sent to a remote engine.
      </p>

      <H2>Retention</H2>
      <p>
        Profile rows, ratings, completed games, puzzle progress, review cards
        and friendships are kept for as long as your account exists. Stale
        seeks are deleted every 5 minutes. Active games may be auto-aborted
        if neither side moves within 30 seconds of game start. Browser-only
        data persists until you clear it.
      </p>

      <H2>Your rights</H2>
      <H3>Access and export</H3>
      <p>
        You can read every row tied to your user id directly from the API
        with your own credentials, since Row-Level Security only restricts
        writes — your own profile, ratings, games, puzzle progress, review
        cards and friendships are all readable by you. To request a packaged
        export, email us at <Code>{CONTACT_EMAIL}</Code>.
      </p>
      <H3>Deletion</H3>
      <p>
        You can sign out and stop using the service at any time. To delete
        your account, email <Code>{CONTACT_EMAIL}</Code> from the address tied
        to the account. Deletion cascades through every table that references
        you: ratings, seeks, challenges, puzzle progress, puzzle attempts,
        review cards, friendships, and your avatar uploads. <Code>games</Code>{" "}
        rows you participated in are kept as historical records, with your
        user id replaced by <Code>null</Code> (your name string is preserved
        because it appears in the PGN).
      </p>
      <H3>Correction</H3>
      <p>
        You can edit your username, display name, bio, country, avatar, and
        the linked Lichess / chess.com handles directly from the Profile
        page. Email us if you need anything else corrected.
      </p>

      <H2>Security</H2>
      <p>
        Every table has Row-Level Security enabled with policies grounded in{" "}
        <Code>auth.uid()</Code>. Server-side privileged actions go through{" "}
        <Code>SECURITY DEFINER</Code> functions that re-check the caller&apos;s
        identity. Passwords are managed by Supabase Auth (bcrypt); we never
        see or store them. All traffic is HTTPS / WSS. The service role key
        never reaches the browser.
      </p>

      <H2>Children</H2>
      <p>
        oChess is intended for users age 13 and over. We do not knowingly
        collect data from children under 13.
      </p>

      <H2>Changes</H2>
      <p>
        If we materially change how we collect or use personal data we will
        update this page and bump the effective date below. Continued use of
        the service after a change constitutes acceptance.
      </p>

      <H2>Contact</H2>
      <p>
        Questions, export requests, deletion requests, or other inquiries:{" "}
        <Code>{CONTACT_EMAIL}</Code>.
      </p>
    </>
  );
}

function TermsContent() {
  return (
    <>
      <p>
        These terms cover your use of oChess. By creating an account, signing
        in with Google, or playing as a guest, you agree to them. If you do
        not agree, do not use the service.
      </p>

      <H2>Who runs oChess</H2>
      <p>
        oChess is a free, open-source hobby project run by {OPERATOR}. There
        is no company, no employees, no paid support staff, and no revenue.
        The service is offered as-is, on a best-effort basis, in the
        operator&apos;s spare time. Treat it accordingly.
      </p>

      <H2>Eligibility</H2>
      <p>
        You must be at least 13 years old to use oChess. You are responsible
        for any account credentials you create and for activity under your
        account.
      </p>

      <H2>Acceptable use</H2>
      <p>
        While using the service you agree not to:
      </p>
      <ul className="list-disc pl-5 space-y-1">
        <li>
          Use any chess engine, software, opening database, or human
          assistance during rated games. This is cheating and will result in
          account suspension or removal.
        </li>
        <li>
          Harass, threaten, or abuse other players in chat or anywhere else
          the service exposes user-to-user communication. Chat is filtered for
          a small list of obvious slurs but you must still behave decently.
        </li>
        <li>
          Attempt to bypass authentication, Row-Level Security, rate limits,
          or other protective controls.
        </li>
        <li>
          Scrape the database at high volume, register many accounts to
          inflate ratings, or otherwise abuse system resources.
        </li>
        <li>
          Upload avatars or set profile fields that are illegal, sexual,
          violent, harassing, or that infringe someone else&apos;s rights.
        </li>
        <li>
          Use the service in any way that breaks the law in your jurisdiction
          or in {JURISDICTION}.
        </li>
      </ul>

      <H2>Content you submit</H2>
      <p>
        Game moves, chat messages, profile fields, and avatars you submit
        remain yours. By submitting them you grant oChess a non-exclusive,
        royalty-free license to host, store, display, and transmit that
        content as needed to run the service (for example, sending your
        moves to your opponent and showing your profile to other users).
        Completed games are publicly viewable as part of how oChess works.
      </p>

      <H2>Open-source components</H2>
      <p>
        oChess is open source under the Apache-2.0 license. The repository
        bundles third-party software under separate licenses, including
        Stockfish (GPLv3), the Lichess puzzle database (ODbL), and various
        MIT / Apache-2.0 libraries. See the{" "}
        <Link className="underline" to="/legal/attribution">Attribution</Link>{" "}
        page for the full list. Your use of the bundled software is governed
        by the original licenses; we are bound by their terms when we
        distribute them.
      </p>

      <H2>Service availability</H2>
      <p>
        oChess is provided on an &quot;AS IS&quot; and &quot;AS AVAILABLE&quot;
        basis. There is no service level agreement, no uptime guarantee, no
        backup guarantee, and no warranty of any kind. The operator may
        change, suspend, or discontinue any part of the service at any time
        — including features, accounts, stored games, ratings, and the
        entire platform — without notice and without liability.
      </p>

      <H2>You assume all risk</H2>
      <p>
        Use of oChess is entirely at your own risk. The operator does not
        promise that the service will work, that data you store will be
        preserved, that ratings will remain stable across schema changes,
        that opponents will behave fairly, or that the service will be
        available at any particular time. If any of these things matter to
        you, do not rely on oChess; use a paid platform instead.
      </p>

      <H2>Disclaimer of warranties</H2>
      <p>
        To the maximum extent permitted by Finnish law and any other
        applicable law, the operator disclaims all express and implied
        warranties of any kind — including but not limited to merchantability,
        fitness for a particular purpose, accuracy, reliability, security,
        non-infringement, and quiet enjoyment. No advice or information
        obtained from the service creates any warranty not expressly stated
        in these terms.
      </p>

      <H2>Limitation of liability</H2>
      <p>
        <strong>To the maximum extent permitted by law, the operator of
        oChess will not be liable to you for any damages of any kind arising
        from or related to your use of the service.</strong> This includes,
        without limitation, direct, indirect, incidental, consequential,
        special, exemplary, punitive, or other damages — whether based on
        warranty, contract, tort (including negligence), product liability,
        statute, or any other legal theory — and whether or not the operator
        has been advised of the possibility of such damages.
      </p>
      <p>
        Because oChess is offered to you free of charge, you and the
        operator agree that any aggregate liability the operator may have
        under any theory is capped at <strong>EUR 0</strong>, equal to the
        amount you have paid for the service.
      </p>
      <p>
        Some jurisdictions do not allow the exclusion of certain warranties
        or the limitation of liability for incidental or consequential
        damages. To the extent that any of the limitations above are not
        permitted in your jurisdiction, they apply to the maximum extent
        permitted by law in that jurisdiction.
      </p>

      <H2>Indemnification</H2>
      <p>
        You agree to indemnify, defend, and hold harmless the operator from
        any claims, damages, losses, liabilities, and expenses (including
        reasonable attorney fees) arising from or related to your use of
        the service, your violation of these terms, your violation of any
        rights of another party, or content you submit through the service.
      </p>

      <H2>Termination</H2>
      <p>
        You may stop using oChess at any time and may request account
        deletion (see <Link className="underline" to="/legal/privacy">Privacy</Link>{" "}
        for what gets removed). We may suspend or terminate accounts that
        violate these terms.
      </p>

      <H2>Governing law</H2>
      <p>
        These terms, and any dispute arising from your use of oChess, are
        governed by the laws of {JURISDICTION}, without regard to its
        conflict-of-laws rules. The exclusive forum and venue for any such
        dispute is the courts of Helsinki, Finland, and you consent to the
        personal jurisdiction of those courts.
      </p>

      <H2>Changes</H2>
      <p>
        We may update these terms. Material changes are reflected by bumping
        the effective date below. Continued use after a change means you
        accept the updated terms.
      </p>

      <H2>Contact</H2>
      <p>
        Questions about these terms: <Code>{CONTACT_EMAIL}</Code>.
      </p>
    </>
  );
}

function AttributionContent() {
  return (
    <>
      <p>
        oChess stands on the shoulders of a lot of open work. The list below
        names every third-party project the live application bundles or
        depends on, with the license under which it is used. Where
        attribution is required by the upstream license (Stockfish, Lichess
        puzzle DB) we surface it explicitly.
      </p>

      <H2>Engines and chess data</H2>
      <ul className="list-disc pl-5 space-y-2">
        <li>
          <strong>Stockfish 18</strong> &mdash; GPLv3.{" "}
          <a className="underline" href="https://stockfishchess.org/" target="_blank" rel="noopener noreferrer">stockfishchess.org</a>.
          The Stockfish source code is available at{" "}
          <a className="underline" href="https://github.com/official-stockfish/Stockfish" target="_blank" rel="noopener noreferrer">github.com/official-stockfish/Stockfish</a>.
          The WebAssembly build we ship is sourced from the upstream
          stockfish.js / stockfish.wasm distribution.
        </li>
        <li>
          <strong>js-chess-engine</strong> &mdash; MIT.{" "}
          <a className="underline" href="https://github.com/josdejong/js-chess-engine" target="_blank" rel="noopener noreferrer">github.com/josdejong/js-chess-engine</a>.
        </li>
        <li>
          <strong>chess.js</strong> &mdash; BSD-2-Clause.{" "}
          <a className="underline" href="https://github.com/jhlywa/chess.js" target="_blank" rel="noopener noreferrer">github.com/jhlywa/chess.js</a>.
        </li>
        <li>
          <strong>Lichess puzzle database</strong> &mdash; ODbL 1.0.{" "}
          <a className="underline" href="https://database.lichess.org/" target="_blank" rel="noopener noreferrer">database.lichess.org</a>.
          Used unchanged. Attribution to Lichess is given here per the ODbL.
        </li>
        <li>
          <strong>Lichess piece sets and sounds</strong> &mdash; bundled
          subject to their original licenses (mostly GPLv3 or
          Creative Commons; see the upstream{" "}
          <a className="underline" href="https://github.com/lichess-org/lila" target="_blank" rel="noopener noreferrer">lichess-org/lila</a>{" "}
          repository for per-asset details). Credit to Lichess for both.
        </li>
      </ul>

      <H2>UI and runtime</H2>
      <ul className="list-disc pl-5 space-y-2">
        <li>
          <strong>React</strong> &mdash; MIT.{" "}
          <a className="underline" href="https://react.dev" target="_blank" rel="noopener noreferrer">react.dev</a>.
        </li>
        <li>
          <strong>Vite</strong> &mdash; MIT.{" "}
          <a className="underline" href="https://vitejs.dev" target="_blank" rel="noopener noreferrer">vitejs.dev</a>.
        </li>
        <li>
          <strong>Tailwind CSS</strong> &mdash; MIT.{" "}
          <a className="underline" href="https://tailwindcss.com" target="_blank" rel="noopener noreferrer">tailwindcss.com</a>.
        </li>
        <li>
          <strong>react-router-dom</strong> &mdash; MIT.{" "}
          <a className="underline" href="https://reactrouter.com" target="_blank" rel="noopener noreferrer">reactrouter.com</a>.
        </li>
        <li>
          <strong>react-chessboard</strong> &mdash; MIT.{" "}
          <a className="underline" href="https://github.com/Clariity/react-chessboard" target="_blank" rel="noopener noreferrer">github.com/Clariity/react-chessboard</a>.
        </li>
        <li>
          <strong>howler.js</strong> &mdash; MIT.{" "}
          <a className="underline" href="https://howlerjs.com" target="_blank" rel="noopener noreferrer">howlerjs.com</a>.
        </li>
      </ul>

      <H2>Backend</H2>
      <ul className="list-disc pl-5 space-y-2">
        <li>
          <strong>Supabase</strong> (Postgres, Auth, Realtime, Storage,
          Edge Functions) &mdash; Apache-2.0 / source-available components.{" "}
          <a className="underline" href="https://supabase.com" target="_blank" rel="noopener noreferrer">supabase.com</a>.
        </li>
        <li>
          <strong>@supabase/supabase-js</strong> &mdash; MIT.
        </li>
      </ul>

      <H2>oChess itself</H2>
      <p>
        The application code in this repository is licensed under{" "}
        <strong>Apache-2.0</strong>. See <Code>LICENSE</Code> and{" "}
        <Code>NOTICE</Code> in the source tree. You are free to fork, modify,
        and ship your own version subject to that license.
      </p>
    </>
  );
}
