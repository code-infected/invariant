export default function NotFound() {
  return (
    <div className="panel empty">
      <h1>Not found</h1>
      <p className="lede">No such batch, task or run in this store.</p>
      <a href="/">Back to the leaderboard</a>
    </div>
  );
}
