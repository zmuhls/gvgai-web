package tools;

import core.game.Observation;
import core.game.StateObservation;
import core.vgdl.VGDLRegistry;
import ontology.Types;
import java.util.*;

/** Bounded weighted A* for GVGAI's absorbing, reusable-hole Sokoban rules.
 * Returned paths are evidence for the decision model, never an action policy.
 * Callers must replay a path in a copy of the engine before calling it a win.
 */
public final class SokobanSearch {
    public static final int MAX_NODES = 60000;
    public static final int MAX_MOVES = 300;
    private static final long MAX_NANOS = 250000000L;
    private static final int[] DX = {-1, 1, 0, 0}, DY = {0, 0, -1, 1};
    private static final Types.ACTIONS[] MOVES = {Types.ACTIONS.ACTION_LEFT,
        Types.ACTIONS.ACTION_RIGHT, Types.ACTIONS.ACTION_UP, Types.ACTIONS.ACTION_DOWN};
    private static final Map<String, List<Types.ACTIONS>> CACHE =
        new LinkedHashMap<String, List<Types.ACTIONS>>(128, 0.75f, true) {
            protected boolean removeEldestEntry(Map.Entry<String, List<Types.ACTIONS>> e) {
                return size() > 4096;
            }
        };

    public static class Result {
        public String status;
        public int expanded;
        public List<Types.ACTIONS> actions;
        Result(String status, int expanded, List<Types.ACTIONS> actions) {
            this.status = status; this.expanded = expanded; this.actions = actions;
        }
    }

    private static final class Board {
        int width, height, player;
        int[] boxes, distance;
        boolean[] walls, holes;
        String layout;
        int neighbor(int cell, int direction) {
            int x = cell % width + DX[direction], y = cell / width + DY[direction];
            return x < 0 || y < 0 || x >= width || y >= height ? -1 : y * width + x;
        }
        int heuristic(int[] positions) {
            int sum = 0;
            for (int p : positions) {
                if (distance[p] == Integer.MAX_VALUE) return Integer.MAX_VALUE;
                sum += distance[p];
            }
            return sum;
        }
    }

    private static final class Node {
        int player, cost, estimate;
        int[] boxes;
        Node parent;
        List<Types.ACTIONS> segment;
        Node(int player, int[] boxes, int cost, int estimate, Node parent, List<Types.ACTIONS> segment) {
            this.player = player; this.boxes = boxes; this.cost = cost;
            this.estimate = estimate; this.parent = parent; this.segment = segment;
        }
    }

    private static String key(int player, int[] boxes) { return player + ":" + Arrays.toString(boxes); }

    public static Result solve(StateObservation observation) {
        return solve(observation, MAX_NODES, MAX_NANOS);
    }

    // Explicit limits also let regressions distinguish exhaustion from a proof.
    public static Result solve(StateObservation observation, int maxNodes, long maxNanos) {
        Board board = read(observation);
        if (board == null) return new Result("unsupported", 0, null);
        if (board.boxes.length == 0) return new Result("solution", 0, Collections.emptyList());
        if (maxNodes <= 0 || maxNanos <= 0) return new Result("budget-exhausted", 0, null);
        String startKey = key(board.player, board.boxes);
        List<Types.ACTIONS> cached = CACHE.get(board.layout + startKey);
        if (cached != null) return new Result("solution", 0, cached);
        int h = board.heuristic(board.boxes);
        if (h == Integer.MAX_VALUE) return new Result("no-solution", 0, null);
        long deadline = System.nanoTime() + maxNanos;
        PriorityQueue<Node> open = new PriorityQueue<>(Comparator
            .comparingInt((Node n) -> n.cost + 4 * n.estimate).thenComparingInt(n -> n.estimate));
        Map<String, Integer> costs = new HashMap<>();
        open.add(new Node(board.player, board.boxes, 0, h, null, Collections.emptyList()));
        costs.put(startKey, 0);
        int expanded = 0;
        boolean clipped = false;
        while (!open.isEmpty()) {
            if (expanded >= maxNodes || System.nanoTime() >= deadline)
                return new Result("budget-exhausted", expanded, null);
            Node node = open.remove();
            if (node.cost != costs.get(key(node.player, node.boxes))) continue;
            if (node.boxes.length == 0) {
                List<Types.ACTIONS> path = path(node);
                cachePath(board, path);
                return new Result("solution", expanded, Collections.unmodifiableList(path));
            }
            expanded++;
            boolean[] occupied = new boolean[board.walls.length];
            for (int p : node.boxes) occupied[p] = true;
            int[] previous = new int[occupied.length], incoming = new int[occupied.length];
            Arrays.fill(previous, -1);
            ArrayDeque<Integer> queue = new ArrayDeque<>();
            queue.add(node.player); previous[node.player] = node.player;
            while (!queue.isEmpty()) {
                int cell = queue.remove();
                for (int d = 0; d < 4; d++) {
                    int next = board.neighbor(cell, d);
                    if (next < 0 || board.walls[next] || occupied[next] || previous[next] >= 0) continue;
                    previous[next] = cell; incoming[next] = d; queue.add(next);
                }
            }
            for (int i = 0; i < node.boxes.length; i++) for (int d = 0; d < 4; d++) {
                int box = node.boxes[i], destination = board.neighbor(box, d);
                int stand = board.neighbor(box, d ^ 1);
                if (destination < 0 || stand < 0 || previous[stand] < 0 ||
                    board.walls[destination] || occupied[destination]) continue;
                int[] boxes = new int[node.boxes.length - (board.holes[destination] ? 1 : 0)];
                for (int j = 0, k = 0; j < node.boxes.length; j++) {
                    if (j != i) boxes[k++] = node.boxes[j];
                    else if (!board.holes[destination]) boxes[k++] = destination;
                }
                Arrays.sort(boxes);
                h = board.heuristic(boxes);
                if (h == Integer.MAX_VALUE) continue;
                List<Types.ACTIONS> segment = new ArrayList<>();
                for (int p = stand; p != node.player; p = previous[p]) segment.add(MOVES[incoming[p]]);
                Collections.reverse(segment); segment.add(MOVES[d]);
                int cost = node.cost + segment.size();
                if (cost + h > MAX_MOVES) { clipped = true; continue; }
                String nextKey = key(box, boxes);
                if (cost >= costs.getOrDefault(nextKey, Integer.MAX_VALUE)) continue;
                costs.put(nextKey, cost);
                open.add(new Node(box, boxes, cost, h, node, segment));
            }
        }
        return new Result(clipped ? "budget-exhausted" : "no-solution", expanded, null);
    }

    private static List<Types.ACTIONS> path(Node end) {
        ArrayDeque<List<Types.ACTIONS>> segments = new ArrayDeque<>();
        for (Node n = end; n.parent != null; n = n.parent) segments.addFirst(n.segment);
        List<Types.ACTIONS> path = new ArrayList<>();
        for (List<Types.ACTIONS> segment : segments) path.addAll(segment);
        return path;
    }

    private static void cachePath(Board board, List<Types.ACTIONS> path) {
        int player = board.player;
        TreeSet<Integer> boxes = new TreeSet<>();
        for (int p : board.boxes) boxes.add(p);
        for (int i = 0; i < path.size(); i++) {
            int[] positions = boxes.stream().mapToInt(Integer::intValue).toArray();
            String cacheKey = board.layout + key(player, positions);
            List<Types.ACTIONS> old = CACHE.get(cacheKey);
            if (old == null || old.size() > path.size() - i) CACHE.put(cacheKey,
                Collections.unmodifiableList(new ArrayList<>(path.subList(i, path.size()))));
            int d = Arrays.asList(MOVES).indexOf(path.get(i)), next = board.neighbor(player, d);
            if (boxes.remove(next)) {
                int pushed = board.neighbor(next, d);
                if (!board.holes[pushed]) boxes.add(pushed);
            }
            player = next;
        }
    }

    private static Board read(StateObservation state) {
        if (state.getBlockSize() <= 0) return null;
        Board b = new Board();
        b.width = state.getWorldDimension().width / state.getBlockSize();
        b.height = state.getWorldDimension().height / state.getBlockSize();
        if (b.width * b.height > 1024 || b.width < 1 || b.height < 1) return null;
        b.walls = new boolean[b.width * b.height]; b.holes = new boolean[b.walls.length];
        ArrayList<Integer> boxes = new ArrayList<>();
        Set<Integer> seen = new HashSet<>();
        for (ArrayList<Observation>[] column : state.getObservationGrid()) for (ArrayList<Observation> cell : column) {
            for (Observation o : cell) {
                if (!seen.add(o.obsID)) continue;
                String name = VGDLRegistry.GetInstance().getRegisteredSpriteKey(o.itype);
                int x = (int)o.position.x / state.getBlockSize(), y = (int)o.position.y / state.getBlockSize();
                if (x < 0 || y < 0 || x >= b.width || y >= b.height) return null;
                int p = y * b.width + x;
                if ("wall".equals(name)) b.walls[p] = true;
                else if ("hole".equals(name)) b.holes[p] = true;
                else if ("box".equals(name)) boxes.add(p);
                else if (!"floor".equals(name) && !"avatar".equals(name)) return null;
            }
        }
        b.player = ((int)state.getAvatarPosition().y / state.getBlockSize()) * b.width +
            (int)state.getAvatarPosition().x / state.getBlockSize();
        if (b.player < 0 || b.player >= b.walls.length || boxes.size() > 8) return null;
        b.boxes = boxes.stream().mapToInt(Integer::intValue).sorted().toArray();
        b.layout = b.width + "/" + b.height + Arrays.toString(b.walls) + Arrays.toString(b.holes);
        b.distance = new int[b.walls.length]; Arrays.fill(b.distance, Integer.MAX_VALUE);
        ArrayDeque<Integer> queue = new ArrayDeque<>();
        for (int p = 0; p < b.holes.length; p++) if (b.holes[p]) { b.distance[p] = 0; queue.add(p); }
        // Pull backwards from reusable holes; there is no one-box/one-goal matching.
        while (!queue.isEmpty()) {
            int cell = queue.remove();
            for (int d = 0; d < 4; d++) {
                int box = b.neighbor(cell, d), stand = box < 0 ? -1 : b.neighbor(box, d);
                if (stand < 0 || b.walls[box] || b.walls[stand] || b.distance[box] != Integer.MAX_VALUE) continue;
                b.distance[box] = b.distance[cell] + 1; queue.add(box);
            }
        }
        return b;
    }
}
