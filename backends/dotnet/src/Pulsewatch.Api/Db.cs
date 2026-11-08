using Dapper;
using Npgsql;

namespace Pulsewatch.Api;

/// <summary>An open connection plus its transaction, handed to the work inside Db.InOrg and friends.</summary>
public sealed record Tx(NpgsqlConnection Conn, NpgsqlTransaction Transaction)
{
    public Task<IEnumerable<T>> Query<T>(string sql, object? args = null) => Conn.QueryAsync<T>(sql, args, Transaction);
    public Task<T?> One<T>(string sql, object? args = null) => Conn.QuerySingleOrDefaultAsync<T>(sql, args, Transaction);
    public Task<int> Execute(string sql, object? args = null) => Conn.ExecuteAsync(sql, args, Transaction);
}

/// <summary>
/// Runs work in a transaction that row-level security scopes to one org (or, for background
/// jobs, to all orgs). set_config(..., true) is transaction-local, so a pooled connection never
/// carries one request's org into the next.
/// </summary>
public sealed class Db(NpgsqlDataSource dataSource)
{
    public NpgsqlDataSource Source => dataSource;

    public Task<T> InOrg<T>(Guid orgId, Func<Tx, Task<T>> work) =>
        Run("SELECT set_config('app.org_id', @org, true)", new { org = orgId.ToString() }, work);

    public Task<T> AsSystem<T>(Func<Tx, Task<T>> work) =>
        Run("SELECT set_config('app.bypass_rls', 'on', true)", null, work);

    /// <summary>For orgs and users, which have no row-level security.</summary>
    public Task<T> Plain<T>(Func<Tx, Task<T>> work) => Run(null, null, work);

    private async Task<T> Run<T>(string? setup, object? args, Func<Tx, Task<T>> work)
    {
        await using var conn = await dataSource.OpenConnectionAsync();
        await using var transaction = await conn.BeginTransactionAsync();
        var tx = new Tx(conn, transaction);
        if (setup is not null) await conn.ExecuteScalarAsync(setup, args, transaction);
        var result = await work(tx);
        await transaction.CommitAsync();
        return result;
    }
}
