package testing;

import core.game.Game;
import core.game.StateObservation;
import core.game.SerializableStateObservation;
import core.vgdl.VGDLFactory;
import core.vgdl.VGDLParser;
import core.vgdl.VGDLRegistry;
import ontology.Types;
import tools.ActionLookahead;
import tools.SokobanSearch;
import tools.com.google.gson.Gson;
import java.util.Map;

/** Check abstract solutions against the unmodified engine, not another solver. */
public final class TestSokobanSearch {
    public static void main(String[] args) {
        for (int level = 0; level < 5; level++) for (int seed : new int[]{7, 42, 2026}) {
            VGDLFactory.GetInstance().init(); VGDLRegistry.GetInstance().init();
            Game game = new VGDLParser().parseGame("examples/gridphysics/sokoban.txt");
            game.buildLevel("examples/gridphysics/sokoban_lvl" + level + ".txt", seed);
            StateObservation state = game.getObservation();
            state.currentGameState = Types.GAMESTATES.ACT_STATE;
            Gson gson = new Gson();
            String before = gson.toJson(new SerializableStateObservation(state));
            long start = System.nanoTime();
            SokobanSearch.Result result = SokobanSearch.solve(state);
            if (!"solution".equals(result.status))
                throw new AssertionError("Level " + level + ": " + result.status + ", nodes=" + result.expanded);
            if (!before.equals(gson.toJson(new SerializableStateObservation(state))))
                throw new AssertionError("Search mutated the live observation");
            StateObservation proof = state.copy();
            for (Types.ACTIONS action : result.actions) proof.advance(action);
            if (proof.getGameWinner() != Types.WINNER.PLAYER_WINS)
                throw new AssertionError("Abstract plan did not win in Java: level " + level);
            if (result.expanded > SokobanSearch.MAX_NODES || result.actions.size() > SokobanSearch.MAX_MOVES)
                throw new AssertionError("Unbounded search");
            if (!"budget-exhausted".equals(SokobanSearch.solve(state, 0, 1).status))
                throw new AssertionError("Budget exhaustion was treated as a deadlock");
            if (level == 0 && seed == 7) {
                StateObservation dead = state.copy(); dead.advance(Types.ACTIONS.ACTION_UP);
                if (!"no-solution".equals(SokobanSearch.solve(dead).status))
                    throw new AssertionError("Missed irreversible first push");
                Map<String, ActionLookahead.Candidate> candidates = ActionLookahead.evaluate(state, "sokoban");
                long verified = candidates.values().stream().filter(c -> c.puzzle.engineVerified).count();
                if (verified < 2) throw new AssertionError("Need multiple verified choices for CLEF");
                for (ActionLookahead.Candidate c : candidates.values()) if (c.puzzle.engineVerified &&
                    (!"PLAYER_WINS".equals(c.continuation.winner) || c.puzzle.solutionMoves != c.continuation.steps))
                    throw new AssertionError("Solution evidence disagrees with engine replay");
            }
            System.out.println("PASS sokoban level=" + level + " seed=" + seed + " moves=" + result.actions.size() +
                " nodes=" + result.expanded + " ms=" + ((System.nanoTime() - start) / 1000000));
        }
    }
}
