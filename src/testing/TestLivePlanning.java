package testing;

import core.game.Game;
import core.game.StateObservation;
import core.game.SerializableStateObservation;
import core.vgdl.VGDLFactory;
import core.vgdl.VGDLParser;
import core.vgdl.VGDLRegistry;
import ontology.Types;
import tools.ActionLookahead;
import tools.com.google.gson.Gson;
import java.util.Map;

/** Real engine coverage of every cabinet's live and per-tick guard observations. */
public final class TestLivePlanning {
    public static void main(String[] args) {
        String[] games = {"hungrybirds", "crossfire", "camelRace", "butterflies", "chopper",
            "pacman", "chase", "digdug", "link", "aliens", "sokoban"};
        for (String name : games) for (int level : new int[]{0,4}) for (int seed : new int[]{7,2026}) {
            VGDLFactory.GetInstance().init(); VGDLRegistry.GetInstance().init();
            Game game = new VGDLParser().parseGame("examples/gridphysics/" + name + ".txt");
            game.buildLevel("examples/gridphysics/" + name + "_lvl" + level + ".txt", seed);
            StateObservation state = game.getObservation();
            state.currentGameState = Types.GAMESTATES.ACT_STATE;
            Gson gson = new Gson();
            String before = gson.toJson(new SerializableStateObservation(state));
            long start = System.nanoTime();
            Map<String, ActionLookahead.Candidate> full = ActionLookahead.evaluateLive(state, name, false);
            double elapsed = (System.nanoTime()-start)/1e6;
            Map<String, ActionLookahead.Candidate> guard = ActionLookahead.evaluateLive(state, name, true);
            if (!before.equals(gson.toJson(new SerializableStateObservation(state)))) throw new AssertionError("Live state mutated");
            for (Types.ACTIONS action : state.getAvailableActions(true)) {
                ActionLookahead.Candidate c = full.get(action.toString()), g = guard.get(action.toString());
                if (c == null || g == null) throw new AssertionError("Missing legal action");
                if (!"sokoban".equals(name) && (c.riskSamples != 7 || c.simulations > 800 || c.continuation.steps > 12))
                    throw new AssertionError("Invalid search bounds or missing risk samples");
                if (g.simulations != 7 || g.riskSamples != 7 || g.continuation.steps != 1)
                    throw new AssertionError("Guard must check every action without deep search");
                if (!c.immediate.actions.get(0).equals(action.toString()) || !g.immediate.actions.get(0).equals(action.toString()))
                    throw new AssertionError("Forecast action differs from key");
                if (!"sokoban".equals(name) && (c.immediateLosses != g.immediateLosses ||
                    c.immediate.scoreDelta != g.immediate.scoreDelta)) throw new AssertionError("Guard changed risk evidence");
            }
            System.out.printf("PASS %s level=%d seed=%d planningMs=%.2f: unchanged state, all legal actions, seven guard samples%n",name,level,seed,elapsed);
        }
    }
}
