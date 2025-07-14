#!/bin/bash

# Tmux Manager for Patreon-to-Audio Project
# Usage: ./scripts/tmux-manager.sh [command] [pane]

SESSION="patreon-podcast"
PANES=("server" "ui" "worker" "logs")

show_help() {
    echo "Tmux Manager for Patreon-to-Audio"
    echo ""
    echo "Usage: $0 [command] [pane]"
    echo ""
    echo "Commands:"
    echo "  logs [pane]     - Show last 20 lines of logs for pane"
    echo "  tail [pane]     - Follow logs for pane (Ctrl+C to exit)"
    echo "  restart [pane]  - Restart specific pane"
    echo "  status         - Show status of all panes"
    echo "  kill [pane]    - Kill specific pane process"
    echo "  start          - Start the entire tmux session"
    echo "  stop           - Stop the entire tmux session"
    echo ""
    echo "Panes: ${PANES[*]}"
    echo ""
    echo "Examples:"
    echo "  $0 logs server     # Show server logs"
    echo "  $0 restart ui      # Restart UI"
    echo "  $0 status          # Show all pane status"
}

check_session() {
    if ! tmux has-session -t "$SESSION" 2>/dev/null; then
        echo "❌ Tmux session '$SESSION' not found. Run 'npm run tmux:start' first."
        exit 1
    fi
}

show_logs() {
    local pane="$1"
    if [[ -z "$pane" ]]; then
        echo "❌ Please specify a pane: ${PANES[*]}"
        exit 1
    fi
    
    check_session
    echo "📋 Last 20 lines from $pane:"
    echo "----------------------------------------"
    tmux capture-pane -t "$SESSION:$pane" -p | tail -20
}

tail_logs() {
    local pane="$1"
    if [[ -z "$pane" ]]; then
        echo "❌ Please specify a pane: ${PANES[*]}"
        exit 1
    fi
    
    check_session
    echo "📋 Following logs from $pane (Ctrl+C to exit):"
    echo "----------------------------------------"
    
    # Follow logs by repeatedly capturing and showing new content
    while true; do
        tmux capture-pane -t "$SESSION:$pane" -p | tail -1
        sleep 1
    done
}

restart_pane() {
    local pane="$1"
    if [[ -z "$pane" ]]; then
        echo "❌ Please specify a pane: ${PANES[*]}"
        exit 1
    fi
    
    check_session
    echo "🔄 Restarting $pane..."
    
    case "$pane" in
        "server")
            npm run tmux:restart:api
            ;;
        "ui")
            npm run tmux:restart:ui
            ;;
        "worker")
            tmux send-keys -t "$SESSION:worker" C-c
            sleep 1
            tmux send-keys -t "$SESSION:worker" "echo 'Worker pane - ready for manual commands'" Enter
            ;;
        "logs")
            tmux send-keys -t "$SESSION:logs" C-c
            sleep 1
            tmux send-keys -t "$SESSION:logs" "echo 'Logs pane - ready for manual commands'" Enter
            ;;
        *)
            echo "❌ Unknown pane: $pane"
            echo "Available panes: ${PANES[*]}"
            exit 1
            ;;
    esac
    
    echo "✅ $pane restarted"
}

show_status() {
    check_session
    echo "📊 Tmux Session Status:"
    echo "----------------------------------------"
    
    for pane in "${PANES[@]}"; do
        echo -n "🔍 $pane: "
        if tmux list-panes -t "$SESSION" -F "#{pane_title}" | grep -q "$pane"; then
            echo "✅ Running"
        else
            echo "❌ Not found"
        fi
    done
    
    echo ""
    echo "📋 Window list:"
    tmux list-windows -t "$SESSION"
}

kill_pane() {
    local pane="$1"
    if [[ -z "$pane" ]]; then
        echo "❌ Please specify a pane: ${PANES[*]}"
        exit 1
    fi
    
    check_session
    echo "💀 Killing processes in $pane..."
    tmux send-keys -t "$SESSION:$pane" C-c
    sleep 1
    echo "✅ $pane processes killed"
}

start_session() {
    echo "🚀 Starting tmux session..."
    npm run tmux:start
}

stop_session() {
    echo "🛑 Stopping tmux session..."
    npm run tmux:stop
}

# Main command handling
case "$1" in
    "logs")
        show_logs "$2"
        ;;
    "tail")
        tail_logs "$2"
        ;;
    "restart")
        restart_pane "$2"
        ;;
    "status")
        show_status
        ;;
    "kill")
        kill_pane "$2"
        ;;
    "start")
        start_session
        ;;
    "stop")
        stop_session
        ;;
    "help"|"-h"|"--help"|"")
        show_help
        ;;
    *)
        echo "❌ Unknown command: $1"
        echo ""
        show_help
        exit 1
        ;;
esac