import ComingSoon from "./ComingSoon";

/**
 * Study (repertoire / chapter system) is on the roadmap but not built
 * yet. The previous version of this page rendered hard-coded sample
 * content with a "Preview" banner; it was confusing and looked half-
 * shipped. Until we have the real thing, render the standard Coming
 * Soon page so users land in a clean, honest state instead of a fake
 * preview. The route still exists so deep links and the navbar entry
 * don't 404.
 */
export default function StudyPage() {
  return <ComingSoon page="Study" />;
}
