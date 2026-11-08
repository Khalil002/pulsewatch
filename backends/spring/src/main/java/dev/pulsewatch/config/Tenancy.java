package dev.pulsewatch.config;

import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Runs work in a transaction that row-level security scopes to one org (or, for background
 * jobs, to all orgs). set_config(..., true) is transaction-local, so a pooled connection never
 * carries one request's org into the next.
 */
@Component
public class Tenancy {
    private final TransactionTemplate tx;
    private final JdbcClient db;

    public Tenancy(TransactionTemplate tx, JdbcClient db) {
        this.tx = tx;
        this.db = db;
    }

    public <T> T inOrg(UUID orgId, Supplier<T> work) {
        return tx.execute(status -> {
            db.sql("SELECT set_config('app.org_id', ?, true)").param(orgId.toString()).query(String.class).single();
            return work.get();
        });
    }

    public <T> T asSystem(Supplier<T> work) {
        return tx.execute(status -> {
            db.sql("SELECT set_config('app.bypass_rls', 'on', true)").query(String.class).single();
            return work.get();
        });
    }

    /** For orgs and users, which have no row-level security. */
    public <T> T plain(Supplier<T> work) {
        return tx.execute(status -> work.get());
    }
}
