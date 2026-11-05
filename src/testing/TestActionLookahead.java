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

/** Integration regressions using unmodified upstream levels, without a provider. */
public final class TestActionLookahead {
    public static void main(String[] args) {
        boolean expanded = args.length > 0 && "--expanded".equals(args[0]);
        String[] games = expanded ? new String[]{"sokoban", "hungrybirds", "camelRace", "crossfire", "butterflies",
            "chase", "aliens", "frogs", "labyrinth", "modality", "zelda"}
            : new String[]{"sokoban", "hungrybirds", "camelRace", "crossfire", "butterflies", "chase"};
        for (String gameName : games) for (int level : expanded ? new int[]{0,4} : new int[]{0})
            for (int seed : expanded ? new int[]{7,2026} : new int[]{42}) {
            VGDLFactory.GetInstance().init();
            VGDLRegistry.GetInstance().init();
            Game game = new VGDLParser().parseGame("examples/gridphysics/" + gameName + ".txt");
            game.buildLevel("examples/gridphysics/" + gameName + "_lvl" + level + ".txt", seed);
            StateObservation state = game.getObservation();
            state.currentGameState = Types.GAMESTATES.ACT_STATE;
            Gson gson = new Gson();
            String before = gson.toJson(new SerializableStateObservation(state));
            Map<String, ActionLookahead.Candidate> forecasts = ActionLookahead.evaluate(state);
            String after = gson.toJson(new SerializableStateObservation(state));
            if (!before.equals(after)) throw new AssertionError(gameName + ": lookahead mutated the live observation");
            for (Types.ACTIONS action : state.getAvailableActions(true)) {
                ActionLookahead.Candidate c = forecasts.get(action.toString());
                if (c == null || c.simulations > 800 || c.continuation.steps > 12) throw new AssertionError("Unbounded or missing forecast");
                if (!c.continuation.actions.get(0).equals(action.toString())) throw new AssertionError("Forecast has wrong first action");
            }
            if (gameName.equals("sokoban") && level == 0) {
                if (!forecasts.get("ACTION_UP").immediate.deadlocked) throw new AssertionError("Missed the first-push Sokoban deadlock");
                if (forecasts.get("ACTION_LEFT").immediate.deadlocked) throw new AssertionError("Rejected a safe Sokoban move");
            }
            System.out.println("PASS " + gameName + " level=" + level + " seed=" + seed +
                ": live state preserved, forecasts bounded, all legal actions covered");
        }
    }
}
