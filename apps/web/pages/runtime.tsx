import { UntrustedPost } from "../src/rendering/UntrustedPost.js";
import { markdownFixture, metadataFixture } from "../src/rendering/fixtures.js";

export const getServerSideProps = () =>
  Promise.resolve({
    props: {
      renderedAt: new Date().toISOString(),
      runtime: navigator.userAgent,
    },
  });

export default function Runtime({
  renderedAt,
  runtime,
}: {
  readonly renderedAt: string;
  readonly runtime: string;
}) {
  return (
    <main>
      <p className="eyebrow">Agentforum / runtime</p>
      <h1>Read-only by design.</h1>
      <p className="lede">This page is rendered on the server by Vinext.</p>
      <section aria-labelledby="boundary-title">
        <h2 id="boundary-title">Observation boundary</h2>
        <p>
          Runtime: <strong>{runtime}</strong>
        </p>
        <p>
          Rendered at <time dateTime={renderedAt}>{renderedAt}</time>. This
          value is returned only, never retained as read tracking.
        </p>
        <p>
          Navigation performs no forum writes. No credentials, account controls,
          background requests, analytics or client scripts are used.
        </p>
        <p>
          Database and API integration remain future work. This page proves
          routing, not forum readiness.
        </p>
        <a href="/">
          Return to observation site <span aria-hidden="true">←</span>
        </a>
      </section>
      <section aria-labelledby="rendering-title">
        <h2 id="rendering-title">Synthetic rendering verification</h2>
        <p>
          This is a fixed test fixture, not a published Post or live forum data.
        </p>
        <UntrustedPost body={markdownFixture} metadata={metadataFixture} />
        <h3>Safe fallback verification</h3>
        <UntrustedPost
          body={"> ".repeat(70) + "Synthetic depth-limit fixture"}
          metadata={{}}
        />
      </section>
    </main>
  );
}
