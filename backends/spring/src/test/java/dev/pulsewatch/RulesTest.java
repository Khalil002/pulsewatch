package dev.pulsewatch;

import static org.assertj.core.api.Assertions.assertThat;

import dev.pulsewatch.worker.Rules;
import org.junit.jupiter.api.Test;

/** The same values are pinned in the Express and .NET unit tests. */
class RulesTest {

    @Test
    void slugifiesNames() {
        assertThat(Rules.slugify("  Acme Corp!! ")).isEqualTo("acme-corp");
        assertThat(Rules.slugify("Ünïcode ☃ Labs")).isEqualTo("n-code-labs");
        assertThat(Rules.slugify("!!!")).isEqualTo("org");
        assertThat(Rules.slugify("a".repeat(39) + " b")).isEqualTo("a".repeat(39));
        assertThat(Rules.orgSlug("Acme Corp")).matches("^acme-corp-[a-z0-9]{4}$");
    }

    @Test
    void apiKeysAreStoredAsSha256() {
        Rules.NewKey key = Rules.newApiKey();
        assertThat(key.key()).matches("^pw_[0-9a-f]{48}$");
        assertThat(key.prefix()).isEqualTo(key.key().substring(0, 10));
        assertThat(key.hash()).isEqualTo(Rules.sha256Hex(key.key()));
        assertThat(Rules.sha256Hex("pw_test")).isEqualTo("7385aabf0686675cf3f41051fc92d688d2c06abb5915f83dcb12b1ca2abfece7");
    }

    @Test
    void signsWebhookBodies() {
        assertThat(Rules.signature("topsecret", "{\"event\":\"monitor.down\"}"))
                .isEqualTo("sha256=c4ca1ce2fb7ca855eac003c9d72f6eb2314d5a15e497849c61c8f04b203a7557");
    }

    @Test
    void backsOffExponentially() {
        assertThat(new long[] {Rules.backoffSeconds(1), Rules.backoffSeconds(2), Rules.backoffSeconds(3), Rules.backoffSeconds(4)})
                .containsExactly(2, 4, 8, 16);
    }

    @Test
    void describesCheckOutcomes() {
        assertThat(Rules.response(200, 200, 12)).isEqualTo(new Rules.Outcome(true, 200, 12, null));
        assertThat(Rules.response(503, 200, 12).error()).isEqualTo("expected 200 but got 503");
        assertThat(Rules.timeout(1000, 1001).error()).isEqualTo("timeout after 1000 ms");
        assertThat(Rules.connectionFailed("ECONNREFUSED", 3).error()).isEqualTo("connection failed: ECONNREFUSED");
    }

    @Test
    void opensAndResolvesIncidents() {
        assertThat(Rules.transition("pending", false)).isEqualTo(new Rules.Transition("down", true, false));
        assertThat(Rules.transition("up", false)).isEqualTo(new Rules.Transition("down", true, false));
        assertThat(Rules.transition("down", false)).isEqualTo(new Rules.Transition("down", false, false));
        assertThat(Rules.transition("down", true)).isEqualTo(new Rules.Transition("up", false, true));
        assertThat(Rules.transition("pending", true)).isEqualTo(new Rules.Transition("up", false, false));
    }
}
