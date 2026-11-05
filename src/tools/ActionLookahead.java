package tools;

import core.game.Observation;
import core.game.StateObservation;
import core.vgdl.VGDLRegistry;
import ontology.Types;
import java.util.*;

/** Bounded forecasts for a remote decision model. Never advances the live state. */
public final class ActionLookahead {
    private static final int DEPTH = 12;
    private static final int WIDTH = 16;
    private static final int MAX_ADVANCES = 800;

    public static class Forecast {
        public double[] position;
        public double scoreDelta;
        public int health;
        public String winner;
        public boolean terminal;
        public boolean deadlocked;
        public double targetDistance;
        public int steps;
        public List<String> actions;
        public double utility;
    }

    public static class Candidate {
        public Forecast immediate;
        public Forecast continuation;
        public int simulations;
        public int immediateLosses;
        public int riskSamples = 7;
        public PuzzleForecast puzzle;
    }

    public static class PuzzleForecast {
        public String status;
        public int expanded;
        public Integer solutionMoves;
        public boolean engineVerified;
    }

    private static class Node {
        StateObservation state;
        ArrayList<String> path;
        Forecast forecast;
        double value;
        Node(StateObservation state, ArrayList<String> path, double initialScore) {
            this.state = state;
            this.path = path;
            forecast = describe(state, path, initialScore);
            value = value(forecast);
        }
    }

    public static Map<String, Candidate> evaluate(StateObservation root) {
        return evaluate(root, null);
    }

    public static Map<String, Candidate> evaluate(StateObservation root, String gameName) {
        if ("sokoban".equals(gameName)) return evaluateSokoban(root);
        Map<String, Candidate> results = new LinkedHashMap<>();
        for (Types.ACTIONS action : root.getAvailableActions(true)) {
            Candidate result = new Candidate();
            StateObservation next = root.copy();
            next.setNewSeed(31 * root.getGameTick() + action.ordinal());
            next.advance(action);
            Node first = new Node(next, new ArrayList<>(Arrays.asList(action.toString())), root.getGameScore());
            Node best = first;
            result.immediate = first.forecast;
            result.simulations = 1;
            result.immediateLosses = next.isGameOver() && next.getGameWinner() != Types.WINNER.PLAYER_WINS ? 1 : 0;
            for (int sample = 1; sample < result.riskSamples; sample++) {
                StateObservation check = root.copy();
                check.setNewSeed(31 * root.getGameTick() + action.ordinal() + sample * 7919);
                check.advance(action);
                result.simulations++;
                if (check.isGameOver() && check.getGameWinner() != Types.WINNER.PLAYER_WINS) result.immediateLosses++;
            }
            List<Node> beam = new ArrayList<>(Arrays.asList(first));
            Set<String> visited = new HashSet<>();
            visited.add(fingerprint(root));
            visited.add(fingerprint(next));
            for (int depth = 2; depth <= DEPTH && !beam.isEmpty() && result.simulations < MAX_ADVANCES; depth++) {
                List<Node> expanded = new ArrayList<>();
                for (Node node : beam) {
                    if (node.state.isGameOver() || node.forecast.deadlocked) continue;
                    for (Types.ACTIONS move : node.state.getAvailableActions(true)) {
                        if (result.simulations >= MAX_ADVANCES) break;
                        StateObservation child = node.state.copy();
                        child.setNewSeed(31 * root.getGameTick() + action.ordinal() * 101 + result.simulations);
                        child.advance(move);
                        result.simulations++;
                        String key = fingerprint(child);
                        if (!visited.add(key)) continue;
                        ArrayList<String> path = new ArrayList<>(node.path);
                        path.add(move.toString());
                        Node candidate = new Node(child, path, root.getGameScore());
                        if (candidate.value > best.value) best = candidate;
                        if (!candidate.state.isGameOver() && !candidate.forecast.deadlocked) expanded.add(candidate);
                    }
                }
                expanded.sort((a, b) -> Double.compare(b.value, a.value));
                beam = new ArrayList<>(expanded.subList(0, Math.min(WIDTH, expanded.size())));
                if ("PLAYER_WINS".equals(best.forecast.winner)) break;
            }
            result.continuation = best.forecast;
            results.put(action.toString(), result);
        }
        return results;
    }

    private static Map<String, Candidate> evaluateSokoban(StateObservation root) {
        Map<String, Candidate> results = new LinkedHashMap<>();
        // Populate bounded suffix caches before comparing first actions.
        SokobanSearch.solve(root);
        for (Types.ACTIONS action : root.getAvailableActions(true)) {
            Candidate c = new Candidate();
            c.riskSamples = 1; c.simulations = 1;
            StateObservation next = root.copy(); next.advance(action);
            ArrayList<String> path = new ArrayList<>(Arrays.asList(action.toString()));
            c.immediate = describe(next, path, root.getGameScore());
            c.continuation = c.immediate;
            c.puzzle = new PuzzleForecast();
            SokobanSearch.Result solution = SokobanSearch.solve(next);
            c.puzzle.status = solution.status; c.puzzle.expanded = solution.expanded;
            if (solution.actions != null) {
                StateObservation proof = next.copy();
                for (Types.ACTIONS move : solution.actions) {
                    if (proof.isGameOver()) break;
                    proof.advance(move); path.add(move.toString()); c.simulations++;
                }
                if (proof.getGameWinner() == Types.WINNER.PLAYER_WINS) {
                    c.puzzle.engineVerified = true;
                    c.puzzle.solutionMoves = path.size();
                    c.continuation = describe(proof, path, root.getGameScore());
                } else c.puzzle.status = "model-mismatch";
            }
            results.put(action.toString(), c);
        }
        return results;
    }

    private static double value(Forecast f) {
        if ("PLAYER_WINS".equals(f.winner)) return 1e9 - f.steps;
        if (f.terminal || f.deadlocked) return -1e9;
        return f.scoreDelta * 1000 - f.targetDistance * 10 - f.steps * 0.1;
    }

    private static Forecast describe(StateObservation s, List<String> path, double initialScore) {
        Forecast f = new Forecast();
        f.position = new double[]{s.getAvatarPosition().x / s.getBlockSize(), s.getAvatarPosition().y / s.getBlockSize()};
        f.scoreDelta = s.getGameScore() - initialScore;
        f.health = s.getAvatarHealthPoints();
        f.winner = s.getGameWinner().toString();
        f.terminal = s.isGameOver();
        f.targetDistance = targetDistance(s);
        f.deadlocked = hasDeadBox(s);
        f.steps = path.size();
        f.actions = path;
        f.utility = value(f);
        return f;
    }

    private static List<Observation> flatten(ArrayList<Observation>[] groups) {
        List<Observation> result = new ArrayList<>();
        if (groups != null) for (ArrayList<Observation> group : groups) result.addAll(group);
        return result;
    }

    private static String name(Observation o) {
        return VGDLRegistry.GetInstance().getRegisteredSpriteKey(o.itype);
    }

    private static double targetDistance(StateObservation s) {
        List<Observation> targets = flatten(s.getPortalsPositions());
        if (targets.isEmpty()) targets = flatten(s.getResourcesPositions());
        if (targets.isEmpty()) targets = flatten(s.getNPCPositions());
        double best = routeDistance(s, targets);
        // Sokoban's holes are immovables, not portals. Preserve sprite identity.
        List<Observation> boxes = new ArrayList<>(), holes = new ArrayList<>();
        for (Observation o : flatten(s.getMovablePositions())) if ("box".equals(name(o))) boxes.add(o);
        for (Observation o : flatten(s.getImmovablePositions())) if ("hole".equals(name(o))) holes.add(o);
        if (!boxes.isEmpty() && !holes.isEmpty()) {
            double sum = 0, approach = Double.POSITIVE_INFINITY;
            for (Observation box : boxes) {
                double distance = Double.POSITIVE_INFINITY;
                for (Observation hole : holes) distance = Math.min(distance, Math.abs(box.position.x - hole.position.x) + Math.abs(box.position.y - hole.position.y));
                sum += distance;
                approach = Math.min(approach, Math.abs(box.position.x - s.getAvatarPosition().x) + Math.abs(box.position.y - s.getAvatarPosition().y));
            }
            return (sum + approach * 0.1) / s.getBlockSize();
        }
        return best;
    }

    private static double routeDistance(StateObservation s, List<Observation> targets) {
        if (targets.isEmpty()) return 0;
        int w = s.getWorldDimension().width / s.getBlockSize(), h = s.getWorldDimension().height / s.getBlockSize();
        int x = (int)s.getAvatarPosition().x / s.getBlockSize(), y = (int)s.getAvatarPosition().y / s.getBlockSize();
        if (x < 0 || y < 0 || x >= w || y >= h) return w * h;
        boolean[][] wall = new boolean[w][h], goal = new boolean[w][h], seen = new boolean[w][h];
        for (Observation o : flatten(s.getImmovablePositions())) if ("wall".equals(name(o))) {
            int ox = (int)o.position.x / s.getBlockSize(), oy = (int)o.position.y / s.getBlockSize();
            if (ox >= 0 && oy >= 0 && ox < w && oy < h) wall[ox][oy] = true;
        }
        for (Observation o : targets) {
            int ox = (int)o.position.x / s.getBlockSize(), oy = (int)o.position.y / s.getBlockSize();
            if (ox >= 0 && oy >= 0 && ox < w && oy < h) goal[ox][oy] = true;
        }
        ArrayDeque<int[]> queue = new ArrayDeque<>();
        queue.add(new int[]{x,y,0}); seen[x][y] = true;
        int[][] directions = {{0,1},{0,-1},{1,0},{-1,0}};
        while (!queue.isEmpty()) {
            int[] p = queue.remove();
            if (goal[p[0]][p[1]]) return p[2];
            for (int[] d : directions) {
                int nx = p[0] + d[0], ny = p[1] + d[1];
                if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[nx][ny] || wall[nx][ny]) continue;
                seen[nx][ny] = true; queue.add(new int[]{nx,ny,p[2]+1});
            }
        }
        return w * h;
    }

    /** Reverse-push reachability detects static Sokoban dead squares, including wall strips. */
    private static boolean hasDeadBox(StateObservation s) {
        List<Observation> boxes = new ArrayList<>(), holes = new ArrayList<>();
        for (Observation o : flatten(s.getMovablePositions())) if ("box".equals(name(o))) boxes.add(o);
        for (Observation o : flatten(s.getImmovablePositions())) if ("hole".equals(name(o))) holes.add(o);
        if (boxes.isEmpty() || holes.isEmpty()) return false;
        int w = s.getWorldDimension().width / s.getBlockSize(), h = s.getWorldDimension().height / s.getBlockSize();
        boolean[][] wall = new boolean[w][h], reachable = new boolean[w][h];
        for (Observation o : flatten(s.getImmovablePositions())) if ("wall".equals(name(o))) {
            int x = (int)o.position.x / s.getBlockSize(), y = (int)o.position.y / s.getBlockSize();
            if (x >= 0 && y >= 0 && x < w && y < h) wall[x][y] = true;
        }
        ArrayDeque<int[]> queue = new ArrayDeque<>();
        for (Observation hole : holes) {
            int x = (int)hole.position.x / s.getBlockSize(), y = (int)hole.position.y / s.getBlockSize();
            reachable[x][y] = true; queue.add(new int[]{x, y});
        }
        int[][] directions = {{0,1},{0,-1},{1,0},{-1,0}};
        while (!queue.isEmpty()) {
            int[] p = queue.remove();
            for (int[] d : directions) {
                int x = p[0] + d[0], y = p[1] + d[1], standX = x + d[0], standY = y + d[1];
                if (standX < 0 || standY < 0 || standX >= w || standY >= h || wall[x][y] || wall[standX][standY] || reachable[x][y]) continue;
                reachable[x][y] = true; queue.add(new int[]{x,y});
            }
        }
        for (Observation box : boxes) if (!reachable[(int)box.position.x / s.getBlockSize()][(int)box.position.y / s.getBlockSize()]) return true;
        return false;
    }

    private static String fingerprint(StateObservation s) {
        StringBuilder key = new StringBuilder();
        key.append(s.getGameScore()).append('/').append(s.getGameWinner()).append('/').append(s.getAvatarHealthPoints())
            .append('/').append(s.getAvatarPosition()).append('/').append(s.getAvatarOrientation()).append('/').append(s.getAvatarResources());
        for (ArrayList<Observation>[] column : s.getObservationGrid()) for (ArrayList<Observation> cell : column) {
            for (Observation o : cell) key.append('|').append(o.itype).append(':').append(o.position.x).append(',').append(o.position.y);
        }
        return key.toString();
    }
}
