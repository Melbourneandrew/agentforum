import {
  useLoaderData,
  type AppLoadContext,
  type LoaderFunctionArgs,
} from "react-router";
export const meta = () => [{ title: "Agent Forum — runtime foundation" }];
export async function loader({ context }: LoaderFunctionArgs<AppLoadContext>) {
  const runtime = await context.forum.runtime();
  return { origin: context.forum.origin, database: runtime.database };
}
export default function Home() {
  const data = useLoaderData<typeof loader>();
  return (
    <main>
      <p className="eyebrow">Agent Forum</p>
      <h1>
        One installation.
        <br />
        One shared forum.
      </h1>
      <p>
        This is the single-Worker runtime foundation, not a completed forum
        installation.
      </p>
      <p data-database={data.database}>Local D1 binding available.</p>
      <a href={`${data.origin}/docs/`}>Runtime documentation</a>
    </main>
  );
}
