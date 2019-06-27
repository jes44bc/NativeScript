/// <reference path="transition-definitions.android.d.ts"/>

// Definitions.
import { NavigationType } from "./frame-common";
import { NavigationTransition, BackstackEntry } from "../frame";
import { ExpandedEntry, ExpandedTransitionListener } from "./fragment.transitions";

// Types.
import { Transition, AndroidTransitionType } from "../transition/transition";
// import { SlideTransition } from "../transition/slide-transition";
// import { FadeTransition } from "../transition/fade-transition";
import { FlipTransition } from "../transition/flip-transition";
import { _resolveAnimationCurve } from "../animation";
import lazy from "../../utils/lazy";
import { isEnabled as traceEnabled, write as traceWrite, categories as traceCategories } from "../../trace";

interface TransitionListener {
    new(entry: ExpandedEntry, transition: androidx.transition.Transition): ExpandedTransitionListener;
}

const intEvaluator = lazy(() => new android.animation.IntEvaluator());
const defaultInterpolator = lazy(() => new android.view.animation.AccelerateDecelerateInterpolator());

export const waitingQueue = new Map<number, Set<ExpandedEntry>>();
export const completedEntries = new Map<number, ExpandedEntry>();

let TransitionListener: TransitionListener;

export function _setAndroidFragmentTransitions(
    animated: boolean,
    navigationTransition: NavigationTransition,
    currentEntry: ExpandedEntry,
    newEntry: ExpandedEntry,
    frameId: number,
    isNestedDefaultTransition?: boolean): void {

    const currentFragment: androidx.fragment.app.Fragment = currentEntry ? currentEntry.fragment : null;
    const newFragment: androidx.fragment.app.Fragment = newEntry.fragment;
    const entries = waitingQueue.get(frameId);
    if (entries && entries.size > 0) {
        throw new Error("Calling navigation before previous navigation finish.");
    }

    allowTransitionOverlap(currentFragment);
    allowTransitionOverlap(newFragment);

    let name = "";
    let transition: Transition;

    if (navigationTransition) {
        transition = navigationTransition.instance;
        name = navigationTransition.name ? navigationTransition.name.toLowerCase() : "";
    }

    if (!animated) {
        name = "none";
    } else if (transition) {
        name = "custom";
    } else if (name.indexOf("slide") !== 0 && name !== "fade" && name.indexOf("flip") !== 0 && name.indexOf("explode") !== 0) {
        // If we are given name that doesn't match any of ours - fallback to default.
        name = "default";
    }

    let currentFragmentNeedsDifferentAnimation = false;
    if (currentEntry) {
        _updateTransitions(currentEntry);
        if (currentEntry.transitionName !== name ||
            currentEntry.transition !== transition) {
            clearExitAndReenterTransitions(currentEntry, true);
            currentFragmentNeedsDifferentAnimation = true;
        }
    }

    if (name === "none") {
        const noTransition = new NoTransition(0, null);

        setupNewFragmentCustomTransition({ duration: 0, curve: null }, newEntry, noTransition);

        if (isNestedDefaultTransition) {
            setTimeout(() => addToWaitingQueue(newEntry));
            setTimeout(() => transitionOrAnimationCompleted(newEntry));
        }

        if (currentFragmentNeedsDifferentAnimation) {
            setupCurrentFragmentCustomTransition({ duration: 0, curve: null }, currentEntry, noTransition);

            if (isNestedDefaultTransition) {
                setTimeout(() => addToWaitingQueue(currentEntry));
                setTimeout(() => transitionOrAnimationCompleted(currentEntry));
            }
        }
    } else if (name === "custom") {
        setupNewFragmentCustomTransition({ duration: transition.getDuration(), curve: transition.getCurve() }, newEntry, transition);
        if (currentFragmentNeedsDifferentAnimation) {
            setupCurrentFragmentCustomTransition({ duration: transition.getDuration(), curve: transition.getCurve() }, currentEntry, transition);
        }
    } else if (name === "default") {
        setupNewFragmentFadeTransition({ duration: 150, curve: null }, newEntry);
        if (currentFragmentNeedsDifferentAnimation) {
            setupCurrentFragmentFadeTransition({ duration: 150, curve: null }, currentEntry);
        }
    } else if (name.indexOf("slide") === 0) {
        setupNewFragmentSlideTransition(navigationTransition, newEntry, name);
        if (currentFragmentNeedsDifferentAnimation) {
            setupCurrentFragmentSlideTransition(navigationTransition, currentEntry, name);
        }
    } else if (name === "fade") {
        setupNewFragmentFadeTransition(navigationTransition, newEntry);
        if (currentFragmentNeedsDifferentAnimation) {
            setupCurrentFragmentFadeTransition(navigationTransition, currentEntry);
        }
    } else if (name === "explode") {
        setupNewFragmentExplodeTransition(navigationTransition, newEntry);
        if (currentFragmentNeedsDifferentAnimation) {
            setupCurrentFragmentExplodeTransition(navigationTransition, currentEntry);
        }
    } else if (name === "flip") {
        console.log("USE NEW FLIP: New Fragment" + navigationTransition.duration);
        const direction = name.substr("flip".length) || "right"; //Extract the direction from the string
        const flipTransition = new FlipTransition(direction, navigationTransition.duration, navigationTransition.curve);

        setupNewFragmentCustomTransition(navigationTransition, newEntry, flipTransition);
        if (currentFragmentNeedsDifferentAnimation) {
            console.log("USE NEW FLIP: Current Fragment");
            setupCurrentFragmentCustomTransition(navigationTransition, currentEntry, flipTransition);
        }
    }

    newEntry.transitionName = name;

    if (currentEntry) {
        currentEntry.transitionName = name;
        if (name === "custom") {
            currentEntry.transition = transition;
        }
    }

    printTransitions(currentEntry);
    printTransitions(newEntry);
}

export function _getAnimatedEntries(frameId: number): Set<BackstackEntry> {
    return waitingQueue.get(frameId);
}

export function _updateTransitions(entry: ExpandedEntry): void {
    const fragment = entry.fragment;
    const enterTransitionListener = entry.enterTransitionListener;
    if (enterTransitionListener && fragment) {
        fragment.setEnterTransition(enterTransitionListener.transition);
    }

    const exitTransitionListener = entry.exitTransitionListener;
    if (exitTransitionListener && fragment) {
        fragment.setExitTransition(exitTransitionListener.transition);
    }

    const reenterTransitionListener = entry.reenterTransitionListener;
    if (reenterTransitionListener && fragment) {
        fragment.setReenterTransition(reenterTransitionListener.transition);
    }

    const returnTransitionListener = entry.returnTransitionListener;
    if (returnTransitionListener && fragment) {
        fragment.setReturnTransition(returnTransitionListener.transition);
    }
}

export function _reverseTransitions(previousEntry: ExpandedEntry, currentEntry: ExpandedEntry): boolean {
    const previousFragment = previousEntry.fragment;
    const currentFragment = currentEntry.fragment;
    let transitionUsed = false;

    const returnTransitionListener = currentEntry.returnTransitionListener;
    if (returnTransitionListener) {
        transitionUsed = true;
        currentFragment.setExitTransition(returnTransitionListener.transition);
    } else {
        currentFragment.setExitTransition(null);
    }

    const reenterTransitionListener = previousEntry.reenterTransitionListener;
    if (reenterTransitionListener) {
        transitionUsed = true;
        previousFragment.setEnterTransition(reenterTransitionListener.transition);
    } else {
        previousFragment.setEnterTransition(null);
    }

    return transitionUsed;
}

// Transition listener can't be static because
// android is cloning transitions and we can't expand them :(
function getTransitionListener(entry: ExpandedEntry, transition: androidx.transition.Transition): ExpandedTransitionListener {
    if (!TransitionListener) {
        @Interfaces([(<any>androidx).transition.Transition.TransitionListener])
        class TransitionListenerImpl extends java.lang.Object implements androidx.transition.Transition.TransitionListener {
            constructor(public entry: ExpandedEntry, public transition: androidx.transition.Transition) {
                super();
                return global.__native(this);
            }

            public onTransitionStart(transition: androidx.transition.Transition): void {
                const entry = this.entry;
                addToWaitingQueue(entry);
                if (traceEnabled()) {
                    traceWrite(`START ${toShortString(transition)} transition for ${entry.fragmentTag}`, traceCategories.Transition);
                }
            }

            onTransitionEnd(transition: androidx.transition.Transition): void {
                const entry = this.entry;
                if (traceEnabled()) {
                    traceWrite(`END ${toShortString(transition)} transition for ${entry.fragmentTag}`, traceCategories.Transition);
                }

                transitionOrAnimationCompleted(entry);
            }

            onTransitionResume(transition: androidx.transition.Transition): void {
                if (traceEnabled()) {
                    const fragment = this.entry.fragmentTag;
                    traceWrite(`RESUME ${toShortString(transition)} transition for ${fragment}`, traceCategories.Transition);
                }
            }

            onTransitionPause(transition: androidx.transition.Transition): void {
                if (traceEnabled()) {
                    traceWrite(`PAUSE ${toShortString(transition)} transition for ${this.entry.fragmentTag}`, traceCategories.Transition);
                }
            }

            onTransitionCancel(transition: androidx.transition.Transition): void {
                if (traceEnabled()) {
                    traceWrite(`CANCEL ${toShortString(transition)} transition for ${this.entry.fragmentTag}`, traceCategories.Transition);
                }
            }
        }

        TransitionListener = TransitionListenerImpl;
    }

    return new TransitionListener(entry, transition);
}

function addToWaitingQueue(entry: ExpandedEntry): void {
    const frameId = entry.frameId;
    let entries = waitingQueue.get(frameId);
    if (!entries) {
        entries = new Set<ExpandedEntry>();
        waitingQueue.set(frameId, entries);
    }

    entries.add(entry);
}

function clearExitAndReenterTransitions(entry: ExpandedEntry, removeListener: boolean): void {
    const fragment: androidx.fragment.app.Fragment = entry.fragment;
    const exitListener = entry.exitTransitionListener;
    if (exitListener) {
        const exitTransition = fragment.getExitTransition();
        if (exitTransition) {
            if (removeListener) {
                exitTransition.removeListener(exitListener);
            }

            fragment.setExitTransition(null);
            if (traceEnabled()) {
                traceWrite(`Cleared Exit ${exitTransition.getClass().getSimpleName()} transition for ${fragment}`, traceCategories.Transition);
            }
        }

        if (removeListener) {
            entry.exitTransitionListener = null;
        }
    }

    const reenterListener = entry.reenterTransitionListener;
    if (reenterListener) {
        const reenterTransition = fragment.getReenterTransition();
        if (reenterTransition) {
            if (removeListener) {
                reenterTransition.removeListener(reenterListener);
            }

            fragment.setReenterTransition(null);
            if (traceEnabled()) {
                traceWrite(`Cleared Reenter ${reenterTransition.getClass().getSimpleName()} transition for ${fragment}`, traceCategories.Transition);
            }
        }

        if (removeListener) {
            entry.reenterTransitionListener = null;
        }
    }
}

export function _clearFragment(entry: ExpandedEntry): void {
    clearEntry(entry, false);
}

export function _clearEntry(entry: ExpandedEntry): void {
    clearEntry(entry, true);
}

function clearEntry(entry: ExpandedEntry, removeListener: boolean): void {
    clearExitAndReenterTransitions(entry, removeListener);

    const fragment: androidx.fragment.app.Fragment = entry.fragment;
    const enterListener = entry.enterTransitionListener;
    if (enterListener) {
        const enterTransition = fragment.getEnterTransition();
        if (enterTransition) {
            if (removeListener) {
                enterTransition.removeListener(enterListener);
            }

            fragment.setEnterTransition(null);
            if (traceEnabled()) {
                traceWrite(`Cleared Enter ${enterTransition.getClass().getSimpleName()} transition for ${fragment}`, traceCategories.Transition);
            }
        }

        if (removeListener) {
            entry.enterTransitionListener = null;
        }
    }

    const returnListener = entry.returnTransitionListener;
    if (returnListener) {
        const returnTransition = fragment.getReturnTransition();
        if (returnTransition) {
            if (removeListener) {
                returnTransition.removeListener(returnListener);
            }

            fragment.setReturnTransition(null);
            if (traceEnabled()) {
                traceWrite(`Cleared Return ${returnTransition.getClass().getSimpleName()} transition for ${fragment}`, traceCategories.Transition);
            }
        }

        if (removeListener) {
            entry.returnTransitionListener = null;
        }
    }
}

function allowTransitionOverlap(fragment: androidx.fragment.app.Fragment): void {
    if (fragment) {
        fragment.setAllowEnterTransitionOverlap(true);
        fragment.setAllowReturnTransitionOverlap(true);
    }
}

function setEnterTransition(navigationTransition: NavigationTransition, entry: ExpandedEntry, transition: androidx.transition.Transition): void {
    setUpNativeTransition(navigationTransition, transition);
    const listener = addNativeTransitionListener(entry, transition);

    // attach listener to JS object so that it will be alive as long as entry.
    entry.enterTransitionListener = listener;
    const fragment: androidx.fragment.app.Fragment = entry.fragment;
    fragment.setEnterTransition(transition);
}

function setExitTransition(navigationTransition: NavigationTransition, entry: ExpandedEntry, transition: androidx.transition.Transition): void {
    setUpNativeTransition(navigationTransition, transition);
    const listener = addNativeTransitionListener(entry, transition);

    // attach listener to JS object so that it will be alive as long as entry.
    entry.exitTransitionListener = listener;
    const fragment: androidx.fragment.app.Fragment = entry.fragment;
    fragment.setExitTransition(transition);
}

function setReenterTransition(navigationTransition: NavigationTransition, entry: ExpandedEntry, transition: androidx.transition.Transition): void {
    setUpNativeTransition(navigationTransition, transition);
    const listener = addNativeTransitionListener(entry, transition);

    // attach listener to JS object so that it will be alive as long as entry.
    entry.reenterTransitionListener = listener;
    const fragment: androidx.fragment.app.Fragment = entry.fragment;
    fragment.setReenterTransition(transition);
}

function setReturnTransition(navigationTransition: NavigationTransition, entry: ExpandedEntry, transition: androidx.transition.Transition): void {
    setUpNativeTransition(navigationTransition, transition);
    const listener = addNativeTransitionListener(entry, transition);

    // attach listener to JS object so that it will be alive as long as entry.
    entry.returnTransitionListener = listener;
    const fragment: androidx.fragment.app.Fragment = entry.fragment;
    fragment.setReturnTransition(transition);
}

function setupNewFragmentSlideTransition(navTransition: NavigationTransition, entry: ExpandedEntry, name: string): void {
    setupCurrentFragmentSlideTransition(navTransition, entry, name);
    const direction = name.substr("slide".length) || "left"; //Extract the direction from the string
    switch (direction) {
        case "left":
            setEnterTransition(navTransition, entry, new androidx.transition.Slide(android.view.Gravity.RIGHT));
            setReturnTransition(navTransition, entry, new androidx.transition.Slide(android.view.Gravity.RIGHT));
            break;

        case "right":
            setEnterTransition(navTransition, entry, new androidx.transition.Slide(android.view.Gravity.LEFT));
            setReturnTransition(navTransition, entry, new androidx.transition.Slide(android.view.Gravity.LEFT));
            break;

        case "top":
            setEnterTransition(navTransition, entry, new androidx.transition.Slide(android.view.Gravity.BOTTOM));
            setReturnTransition(navTransition, entry, new androidx.transition.Slide(android.view.Gravity.BOTTOM));
            break;

        case "bottom":
            setEnterTransition(navTransition, entry, new androidx.transition.Slide(android.view.Gravity.TOP));
            setReturnTransition(navTransition, entry, new androidx.transition.Slide(android.view.Gravity.TOP));
            break;
    }
}

function setupCurrentFragmentSlideTransition(navTransition: NavigationTransition, entry: ExpandedEntry, name: string): void {
    const direction = name.substr("slide".length) || "left"; //Extract the direction from the string
    switch (direction) {
        case "left":
            setExitTransition(navTransition, entry, new androidx.transition.Slide(android.view.Gravity.LEFT));
            setReenterTransition(navTransition, entry, new androidx.transition.Slide(android.view.Gravity.LEFT));
            break;

        case "right":
            setExitTransition(navTransition, entry, new androidx.transition.Slide(android.view.Gravity.RIGHT));
            setReenterTransition(navTransition, entry, new androidx.transition.Slide(android.view.Gravity.RIGHT));
            break;

        case "top":
            setExitTransition(navTransition, entry, new androidx.transition.Slide(android.view.Gravity.TOP));
            setReenterTransition(navTransition, entry, new androidx.transition.Slide(android.view.Gravity.TOP));
            break;

        case "bottom":
            setExitTransition(navTransition, entry, new androidx.transition.Slide(android.view.Gravity.BOTTOM));
            setReenterTransition(navTransition, entry, new androidx.transition.Slide(android.view.Gravity.BOTTOM));
            break;
    }
}

function setupCurrentFragmentCustomTransition(navTransition: NavigationTransition, entry: ExpandedEntry, transition: Transition): void {
    const exitAnimator = transition.createAndroidAnimator(AndroidTransitionType.exit);
    const exitTransition = new org.nativescript.widgets.CustomTransition(exitAnimator, transition.constructor.name + AndroidTransitionType.exit.toString());

    setExitTransition(navTransition, entry, exitTransition);

    const reenterAnimator = transition.createAndroidAnimator(AndroidTransitionType.popEnter);
    const reenterTransition = new org.nativescript.widgets.CustomTransition(reenterAnimator, transition.constructor.name + AndroidTransitionType.popEnter.toString());

    setReenterTransition(navTransition, entry, reenterTransition);
}

export function setupNewFragmentCustomTransition(navTransition: NavigationTransition, entry: ExpandedEntry, transition: Transition): void {
    setupCurrentFragmentCustomTransition(navTransition, entry, transition);

    const enterAnimator = transition.createAndroidAnimator(AndroidTransitionType.enter);
    const enterTransition = new org.nativescript.widgets.CustomTransition(enterAnimator, transition.constructor.name + AndroidTransitionType.enter.toString());
    setEnterTransition(navTransition, entry, enterTransition);

    const returnAnimator = transition.createAndroidAnimator(AndroidTransitionType.popExit);
    const returnTransition = new org.nativescript.widgets.CustomTransition(returnAnimator, transition.constructor.name + AndroidTransitionType.popExit.toString());
    setReturnTransition(navTransition, entry, returnTransition);

}

function setupNewFragmentFadeTransition(navTransition: NavigationTransition, entry: ExpandedEntry): void {
    setupCurrentFragmentFadeTransition(navTransition, entry);

    const fadeInEnter = new androidx.transition.Fade(androidx.transition.Fade.IN);
    setEnterTransition(navTransition, entry, fadeInEnter);

    const fadeOutReturn = new androidx.transition.Fade(androidx.transition.Fade.OUT);
    setReturnTransition(navTransition, entry, fadeOutReturn);
}

function setupCurrentFragmentFadeTransition(navTransition: NavigationTransition, entry: ExpandedEntry): void {
    const fadeOutExit = new androidx.transition.Fade(androidx.transition.Fade.OUT);
    setExitTransition(navTransition, entry, fadeOutExit);

    // NOTE: There is a bug in Fade transiti on so we need to set all 4
    // otherwise back navigation will complete immediately (won't run the reverse transition).
    const fadeInReenter = new androidx.transition.Fade(androidx.transition.Fade.IN);
    setReenterTransition(navTransition, entry, fadeInReenter);
}

function setupCurrentFragmentExplodeTransition(navTransition: NavigationTransition, entry: ExpandedEntry): void {
    setExitTransition(navTransition, entry, new androidx.transition.Explode());
    setReenterTransition(navTransition, entry, new androidx.transition.Explode());
}

function setupNewFragmentExplodeTransition(navTransition: NavigationTransition, entry: ExpandedEntry): void {
    setupCurrentFragmentExplodeTransition(navTransition, entry);

    setEnterTransition(navTransition, entry, new androidx.transition.Explode());
    setReturnTransition(navTransition, entry, new androidx.transition.Explode());
}

function setUpNativeTransition(navigationTransition: NavigationTransition, nativeTransition: androidx.transition.Transition) {
    if (navigationTransition.duration) {
        nativeTransition.setDuration(navigationTransition.duration);
    }

    const interpolator = navigationTransition.curve ? _resolveAnimationCurve(navigationTransition.curve) : defaultInterpolator();
    nativeTransition.setInterpolator(interpolator);
}

export function addNativeTransitionListener(entry: ExpandedEntry, nativeTransition: androidx.transition.Transition): ExpandedTransitionListener {
    const listener = getTransitionListener(entry, nativeTransition);
    nativeTransition.addListener(listener);
    return listener;
}

function transitionOrAnimationCompleted(entry: ExpandedEntry): void {
    const frameId = entry.frameId;
    const entries = waitingQueue.get(frameId);
    // https://github.com/NativeScript/NativeScript/issues/5759
    // https://github.com/NativeScript/NativeScript/issues/5780
    // transitionOrAnimationCompleted fires again (probably bug in android)
    // NOTE: we cannot reproduce this issue so this is a blind fix
    if (!entries) {
        return;
    }

    entries.delete(entry);
    if (entries.size === 0) {
        const frame = entry.resolvedPage.frame;

        // We have 0 or 1 entry per frameId in completedEntries
        // So there is no need to make it to Set like waitingQueue
        const previousCompletedAnimationEntry = completedEntries.get(frameId);
        completedEntries.delete(frameId);
        waitingQueue.delete(frameId);

        if (frame) {
            const navigationContext = frame._executingContext || { navigationType: NavigationType.back };
            let current = frame.isCurrent(entry) ? previousCompletedAnimationEntry : entry;
            current = current || entry;
            // Will be null if Frame is shown modally...
            // transitionOrAnimationCompleted fires again (probably bug in android).
            if (current) {
                setTimeout(() => frame.setCurrent(current, navigationContext.navigationType));
            }
        }
    } else {
        completedEntries.set(frameId, entry);
    }
}

function toShortString(nativeTransition: androidx.transition.Transition): string {
    return `${nativeTransition.getClass().getSimpleName()}@${nativeTransition.hashCode().toString(16)}`;
}

function printTransitions(entry: ExpandedEntry) {
    if (entry && traceEnabled()) {
        let result = `${entry.fragmentTag} Transitions:`;
        if (entry.transitionName) {
            result += `transitionName=${entry.transitionName}, `;
        }

        const fragment = entry.fragment;
        result += `${fragment.getEnterTransition() ? " enter=" + toShortString(fragment.getEnterTransition()) : ""}`;
        result += `${fragment.getExitTransition() ? " exit=" + toShortString(fragment.getExitTransition()) : ""}`;
        result += `${fragment.getReenterTransition() ? " popEnter=" + toShortString(fragment.getReenterTransition()) : ""}`;
        result += `${fragment.getReturnTransition() ? " popExit=" + toShortString(fragment.getReturnTransition()) : ""}`;

        traceWrite(result, traceCategories.Transition);
    }
}

function javaObjectArray(...params: java.lang.Object[]) {
    const nativeArray = Array.create(java.lang.Object, params.length);
    params.forEach((value, i) => nativeArray[i] = value);
    return nativeArray;
}

function createDummyZeroDurationAnimator(): android.animation.AnimatorSet {
    const animatorSet = new android.animation.AnimatorSet();
    const objectAnimators = Array.create(android.animation.Animator, 1);

    const values = Array.create("float", 3);
    values[0] = 0.0;
    values[1] = 0.0;
    values[2] = 255.0;

    const animator = <android.animation.Animator>android.animation.ObjectAnimator.ofFloat(null, "alpha", values);
    animator.setDuration(0);
    objectAnimators[0] = animator;
    animatorSet.playTogether(objectAnimators);
    // const animator = android.animation.ValueAnimator.ofObject(intEvaluator(), javaObjectArray(java.lang.Integer.valueOf(0), java.lang.Integer.valueOf(1)));
    // animator.setDuration(0);
    // objectAnimators[0] = animator;
    // animatorSet.play(animator);

    return animatorSet;
}

class NoTransition extends Transition {
    public createAndroidAnimator(transitionType: string): android.animation.AnimatorSet {
        return createDummyZeroDurationAnimator();
    }
}
