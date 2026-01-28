# GVGAI Setup Guide - MVP Proof of Concept

## Overview
This guide documents the setup and execution of the General Video Game AI (GVGAI) framework as a proof of concept, demonstrating an AI agent playing a single game.

## What is GVGAI?
GVGAI is an open platform for testing AI agents across many 2D games written in Video Game Description Language (VGDL). The framework parses game descriptions and exposes an API for agents to interact with game states and select actions.

## System Requirements
- **Java**: OpenJDK 11 or higher
- **macOS**: Tested on macOS with Homebrew
- **Memory**: At least 512MB RAM for simple games

## Installation Steps

### 1. Install Dependencies (macOS with Homebrew)
```bash
# Install Java 11 and Apache ANT
brew install openjdk@11 ant

# Set up Java environment (add to ~/.zshrc for persistence)
export PATH="/usr/local/opt/openjdk@11/bin:$PATH"
export JAVA_HOME="/usr/local/opt/openjdk@11"
```

### 2. Clone Repository
```bash
git clone https://github.com/GAIGResearch/GVGAI.git
cd GVGAI
```

### 3. Compile Project
```bash
# Generate list of source files
/usr/bin/find src -name "*.java" > sources.txt

# Compile all Java files
javac -cp "gson-2.6.2.jar" -d out @sources.txt
```

## Running the Demo

### Current Configuration
The demo is configured to run:
- **Game**: Aliens (a grid-based shooter)
- **Agent**: Random Agent (makes random action choices)
- **Level**: Level 0
- **Mode**: Automated AI play with visual output

### Execute the Demo
```bash
# Run the test
export PATH="/usr/local/opt/openjdk@11/bin:/usr/bin:$PATH"
export JAVA_HOME="/usr/local/opt/openjdk@11"
java -cp "out:gson-2.6.2.jar:." tracks.singlePlayer.Test
```

### Expected Output
The game will run and display:
- A graphical window showing the game in progress
- The random agent making decisions in real-time
- Console output showing the final result

Example output:
```
Result (1->win; 0->lose): Player0:0, Player0-Score:53.0, timesteps:477
```

This indicates:
- **Result**: 0 = the agent lost the game
- **Score**: 53.0 points achieved
- **Timesteps**: 477 game ticks elapsed

## What This Demonstrates

### Framework Capabilities
1. **VGDL Parsing**: The framework successfully parses the Aliens game definition
2. **Agent API**: The random agent interfaces with the game state observation API
3. **Action Selection**: Agent receives state, chooses actions, and affects game outcome
4. **Visual Rendering**: Game renders in real-time showing agent behavior
5. **Game Logic**: Win/loss conditions, scoring, and collision detection work correctly

### Agent API Overview
Agents in GVGAI:
- Extend `AbstractPlayer` class
- Implement constructor: `Agent(StateObservation so, ElapsedCpuTimer timer)`
- Implement action method: `Types.ACTIONS act(StateObservation stateObs, ElapsedCpuTimer timer)`

The `StateObservation` provides:
- NPC positions and types
- Immovable/movable object positions
- Resources and portals
- Available actions for current state
- Game-over status
- State copying for look-ahead search

## Available Games
The framework includes 100+ games across different physics engines:
- **Grid Physics**: Aliens, Pac-Man, Zelda, Sokoban, Boulder Dash, and more
- **Continuous Physics**: Physics-based games with continuous movement
- **2-Player Games**: Competitive games for multi-agent testing

See [examples/all_games_sp.csv](examples/all_games_sp.csv) for the complete list.

## Available Agents
Several sample agents are included:

### Simple Agents
- **DoNothingAgent**: Takes no actions (baseline)
- **RandomAgent**: Selects random valid actions
- **OneStepLookahead**: Evaluates one-step-ahead states
- **GreedyTreeSearch**: Basic greedy search

### Advanced Agents
- **MCTS**: Monte Carlo Tree Search
- **RHEA**: Rolling Horizon Evolutionary Algorithm
- **OLETS**: Open Loop Expectimax Tree Search

## Customization

### Change the Game
Edit [src/tracks/singlePlayer/Test.java](src/tracks/singlePlayer/Test.java):
```java
int gameIdx = 0;  // Change to select different game from CSV
int levelIdx = 0; // Change to select different level (0-4)
```

Game indices correspond to lines in [examples/all_games_sp.csv](examples/all_games_sp.csv):
- 0 = Aliens
- 9 = Bomberman
- 19 = Chips Challenge
- 37 = Pac-Man
- 78 = Zelda

### Change the Agent
Edit [src/tracks/singlePlayer/Test.java](src/tracks/singlePlayer/Test.java):
```java
// Available controller options (already defined in Test.java)
String sampleRandomController = "tracks.singlePlayer.simple.sampleRandom.Agent";
String doNothingController = "tracks.singlePlayer.simple.doNothing.Agent";
String sampleMCTSController = "tracks.singlePlayer.advanced.sampleMCTS.Agent";

// Change the controller on line 52
ArcadeMachine.runOneGame(game, level1, visuals, sampleRandomController, recordActionsFile, seed, 0);
```

### Disable Visuals
Set `visuals = false` in Test.java for faster headless execution (useful for batch testing).

## Project Structure
```
GVGAI/
├── src/                    # Source code
│   ├── core/              # Core game engine
│   ├── ontology/          # Game object ontology
│   ├── tools/             # Utility tools
│   └── tracks/            # Competition tracks and test runners
│       └── singlePlayer/  # Single-player track
│           ├── Test.java  # Main test runner (entry point)
│           ├── simple/    # Simple agent implementations
│           └── advanced/  # Advanced agent implementations
├── examples/              # Game definitions
│   ├── gridphysics/      # Grid-based games (100+ games)
│   ├── contphysics/      # Continuous physics games
│   └── *.csv             # Game collections
├── sprites/              # Game graphics
├── gson-2.6.2.jar       # JSON library dependency
└── out/                 # Compiled classes (created during build)
```

## Next Steps

### Expand the MVP
1. **Test Multiple Games**: Run different games to verify framework versatility
2. **Compare Agents**: Run same game with different agents (random vs MCTS)
3. **Batch Testing**: Enable bulk testing across multiple games and levels
4. **Create Custom Agent**: Implement your own AI strategy
5. **Record Actions**: Enable action recording for replay analysis

### Development Ideas
- Implement learning-based agents using the state observation API
- Create visualization tools for agent decision-making
- Build automated testing suites for agent performance comparison
- Design custom games using VGDL
- Integrate with machine learning frameworks

## Troubleshooting

### Java Not Found
```bash
# Verify Java installation
java -version
javac -version

# Ensure PATH is set correctly
export PATH="/usr/local/opt/openjdk@11/bin:$PATH"
```

### Compilation Errors
- Ensure you're compiling from the GVGAI root directory
- Check that gson-2.6.2.jar exists in the root directory
- Verify all source files are being found

### Game Won't Run
- Check that compilation created the `out/` directory with .class files
- Verify classpath includes: `out:gson-2.6.2.jar:.`
- Ensure you're running from the GVGAI root directory (resources need relative paths)

### Display Issues
- macOS may require granting Java permission to access screen recording
- For headless execution, set `visuals = false` in Test.java

## Resources
- **Official Site**: http://www.gvgai.net/
- **GitHub**: https://github.com/GAIGResearch/GVGAI
- **Google Group**: https://groups.google.com/forum/#!forum/the-general-video-game-competition
- **Learning Track**: https://github.com/rubenrtorrado/GVGAI_GYM

## Results Summary
- Repository cloned successfully
- Project compiled without errors
- Aliens game executed with random agent
- Agent completed gameplay (477 timesteps, score: 53.0)
- Framework validated and operational

## License
See [LICENSE.txt](LICENSE.txt) for framework licensing details.
