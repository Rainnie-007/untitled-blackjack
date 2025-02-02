import { FilterQuery, UpdateQuery } from "mongoose";
import { IUser, User, ZodUserStrip, _IUser } from "../models/UserModel";
import { asyncTransaction } from "../utils/Transaction";
import { Card, hiddenCard } from "../utils/Card";
import {
  ERR_INVALID_GAME,
  ERR_INVALID_TRUMP_CARD,
  ERR_INVALID_USER,
  ERR_NO_TRUMP_FOUND,
  ERR_TRUMP_USE_DENIED,
  insertErrorStack,
} from "../utils/error";
import { TrumpCard, TrumpCardDocument } from "../models/TrumpCardModel";
import { trumpCardsAsArray } from "../../../../apps/backend/src/gameplay/trumpcards/TrumpCard";
import { GameController } from "./GameController";

const getAllConnections = asyncTransaction(async () => {
  const _ = (await User.find().select(["connectionId"])) as unknown as _IUser[];
  return _.map((user) => user.connectionId);
});

const clearStaleConnection = asyncTransaction(
  async (connectionIds: string[]) => {
    const _ = await User.deleteMany({ connectionId: { $in: connectionIds } });
    return _;
  }
);

const createUser = asyncTransaction(async (args: FilterQuery<IUser>) => {
  const _ = new User(args);
  const res = await _.save();

  return res;
});

/**
 * @description Update a user instance
 * TRY NOT TO USE THIS FOR SECURITY REASONS
 */
const updateUser = asyncTransaction(
  async (target: FilterQuery<IUser>, value: UpdateQuery<IUser>) => {
    console.log(value);
    const _ = await User.updateOne(target, value);
    if (!_) {
      return new Error("User not found");
    }

    const [user, err] = await UserController.getUserMeta(target);
    if (err) throw err;

    return user;
  }
);

/**
 * @description Delete a user instance
 */
const deleteUser = asyncTransaction(async (args: FilterQuery<IUser>) => {
  const _ = await User.deleteMany(args);
  return _;
});

/**
 * @descrition Get basic non-sensitive user information
 * @param args
 */
const getUserMeta = asyncTransaction(async (args: FilterQuery<IUser>) => {
  const _ = await User.findOne(args).select({
    cards: 0,
    connectionId: 0,
  });
  if (!_) throw insertErrorStack(ERR_INVALID_USER);
  return ZodUserStrip.parse(_);
});

/**
 * @description Get user session id (sensitive information)
 * @param args
 * @returns
 */
const getConnectionId = asyncTransaction(async (args: FilterQuery<IUser>) => {
  const _ = (await User.findOne(args).select([
    "connectionId",
  ])) as unknown as _IUser;
  if (!_?.connectionId) throw insertErrorStack(ERR_INVALID_USER);
  return _.connectionId;
});

const getCards = asyncTransaction(
  async (
    args: FilterQuery<IUser>,
    all: boolean = false,
    /**
     * Bypass the blind check
     */
    bypassBlind: boolean = false,
    /**
     * Overwrite the blind status
     */
    overwriteIsBlind: boolean = false
  ) => {
    const _ = (await User.findOne(args)) as unknown as _IUser;

    let cards =
      (_.trumpStatus.includes("BLIND") && !bypassBlind) || overwriteIsBlind
        ? _.cards.map((_) => hiddenCard)
        : _.cards;

    if (all) return cards! ?? [];

    cards[0] = hiddenCard;

    return cards;
  }
);

const setCards = asyncTransaction(
  async (connectionId: string, cards: Card[]) => {
    const [userMeta] = await getUserMeta({ connectionId });
    if (!userMeta) throw insertErrorStack(ERR_INVALID_USER);

    const _ = await User.findOneAndUpdate(
      {
        _id: userMeta.id,
      },
      {
        cards,
      }
    );

    const [updated, err] = await getUserMeta({ connectionId });
    if (err) throw err;

    if (!updated) throw insertErrorStack(ERR_INVALID_USER);
    return ZodUserStrip.parse(updated);
  }
);

const addCards = asyncTransaction(
  async (userTarget: FilterQuery<IUser>, cards: Card[]) => {
    const [oldCards, err] = await getCards({ ...userTarget });
    if (err) {
      throw insertErrorStack(ERR_INVALID_USER);
    }

    await User.findOneAndUpdate(
      {
        ...userTarget,
      },
      {
        $push: {
          cards: {
            $each: cards,
          },
        },
      }
    );

    return [...cards, ...oldCards];
  }
);

const removeCards = asyncTransaction(
  async (connectionId: string, cards: Card[]) => {
    const [oldCards, err] = await getCards({ connectionId });
    if (err) throw err;

    const newCards = oldCards.filter(
      (card) => !cards.map((c) => c.display).includes(card.display)
    );

    const [user, errSet] = await setCards(connectionId, newCards);
    if (errSet) throw errSet;

    return oldCards.filter(
      (card) => !cards.map((c) => c.display).includes(card.display)
    );
  }
);

const setReadyState = asyncTransaction(
  async (connectionId: string, ready: boolean) => {
    const [userMeta, err] = await getUserMeta({ connectionId });
    if (err) {
      throw insertErrorStack(ERR_INVALID_USER);
    }
    if (!userMeta) {
      throw insertErrorStack(ERR_INVALID_USER);
    }

    const _ = await User.findOneAndUpdate(
      {
        _id: userMeta.id,
      },
      {
        $set: {
          ready,
        },
      }
    );

    if (!_) throw insertErrorStack(ERR_INVALID_USER);

    return ZodUserStrip.parse(_);
  }
);

const setStandState = asyncTransaction(
  async (target: FilterQuery<IUser>, stand: boolean) => {
    // check if the user exists
    const [userMeta, err] = await getUserMeta(target);
    if (err) throw err;

    // update the user
    const _ = await User.findOneAndUpdate(target, {
      stand,
    });

    const [updated, err2] = await getUserMeta(target);
    if (err2) throw err2;

    return ZodUserStrip.parse(updated);
  }
);

const getCardsSums = asyncTransaction(async (target: FilterQuery<IUser>) => {
  const [cards, err] = await getCards(target, true);
  if (err) throw err;

  const firstSum = cards.reduce((acc, card) => {
    if (card.display === "A") return acc + 1;
    if (card.display === "J" || card.display === "Q" || card.display === "K")
      return acc + 10;
    return acc + Number(card.values[0]);
  }, 0);

  const secondSum = cards.reduce((acc, card) => {
    if (card.display === "A") return acc + 11;
    if (card.display === "J" || card.display === "Q" || card.display === "K")
      return acc + 10;
    return acc + Number(card.values[0]);
  }, 0);

  return [firstSum, secondSum];
});

const resetPlayersState = asyncTransaction(
  async (target: FilterQuery<IUser>) => {
    const _ = await User.updateMany(
      {
        ...target,
      },
      {
        $set: {
          stand: false,
          ready: false,
          gameScore: 0,
          cards: [],
          trumpCards: [],
          trumpStatus: [],
        },
      }
    );

    const [updated, err] = await getUserMeta(target);
    if (err) throw err;

    return ZodUserStrip.parse(updated);
  }
);

const getTrumpCards = asyncTransaction(async (target: FilterQuery<IUser>) => {
  const _ = (await User.findOne(target).select(
    "trumpCards"
  )) as unknown as _IUser;
  if (!_) throw insertErrorStack(ERR_INVALID_USER);
  return _.trumpCards;
});

const setTrumpCards = asyncTransaction(
  async (target: FilterQuery<IUser>, cards: TrumpCard[]) => {
    const _ = await User.findOneAndUpdate(
      {
        ...target,
      },
      {
        trumpCards: cards,
      }
    );

    const [updated, err] = await getUserMeta(target);
    if (err) throw err;

    return updated;
  }
);

const addTrumpCards = asyncTransaction(
  async (target: FilterQuery<IUser>, cards: TrumpCard[]) => {
    // check if already has the card or not
    const [ownedTrumpCardsAsDoc, err] = await getTrumpCards(target);
    if (err) throw err;

    if (
      ownedTrumpCardsAsDoc.find((owned) =>
        cards.find((c) => c.handler === owned.handler)
      )
    )
      return ownedTrumpCardsAsDoc;

    const _ = await User.findOneAndUpdate(
      {
        ...target,
      },
      {
        $push: {
          trumpCards: cards,
        },
      }
    );

    const [updated, err2] = await getTrumpCards(target);
    if (err2) throw err2;

    return updated;
  }
);

const removeTrumpCards = asyncTransaction(
  async (target: FilterQuery<IUser>, cards?: TrumpCard[]) => {
    let updatedTrumps: TrumpCardDocument[] = [];

    if (cards) {
      // get the current trump cards
      const [ownedTrumpCardsAsDoc, err] = await getTrumpCards(target);
      if (err) throw err;

      // remove the cards
      updatedTrumps = ownedTrumpCardsAsDoc.filter((owned) =>
        cards.find((c) => c.handler !== owned.handler)
      );
    }

    const _ = await User.findOneAndUpdate(
      {
        ...target,
      },
      {
        $set: {
          trumpCards: updatedTrumps,
        },
      }
    );

    const [updated, err] = await getTrumpCards(target);
    if (err) throw err;

    return updated;
  }
);

const setTrumpStatus = asyncTransaction(
  async (target: FilterQuery<IUser>, status: IUser["trumpStatus"][0][]) => {
    const [_, err] = await getUserMeta(target);
    if (err) throw err;

    const _2 = await User.findOneAndUpdate(
      {
        ...target,
      },
      {
        $set: {
          trumpStatus: status,
        },
      }
    );

    const [updated, errUpdate] = await getUserMeta(target);
    if (errUpdate) throw errUpdate;

    return updated.trumpStatus;
  }
);

const addTrumpStatus = asyncTransaction(
  async (target: FilterQuery<IUser>, status: IUser["trumpStatus"][0]) => {
    const [_, err] = await getUserMeta(target);
    if (err) throw err;

    if (_.trumpStatus.includes(status)) return _.trumpStatus;

    const _2 = await User.findOneAndUpdate(
      {
        ...target,
      },
      {
        $push: {
          trumpStatus: status,
        },
      }
    );

    const [updated, errUpdate] = await getUserMeta(target);
    if (errUpdate) throw errUpdate;

    return updated.trumpStatus;
  }
);

const removeTrumpStatus = asyncTransaction(
  async (target: FilterQuery<IUser>, status?: IUser["trumpStatus"][0]) => {
    if (status) {
      const _ = await User.findOneAndUpdate(
        {
          ...target,
        },
        {
          $pull: {
            trumpStatus: status,
          },
        }
      );
    } else {
      const _ = await User.findOneAndUpdate(
        {
          ...target,
        },
        {
          $set: {
            trumpStatus: [],
          },
        }
      );
    }

    const [updated, err] = await getUserMeta(target);
    if (err) throw err;

    return updated.trumpStatus;
  }
);

const checkInvincibility = asyncTransaction(
  async (target: FilterQuery<IUser>) => {
    const [user, err] = await getUserMeta(target);
    if (err) throw err;

    return user.trumpStatus.includes("INVINCIBLE");
  }
);

const useTrumpCard = asyncTransaction(
  async (trumpUser: FilterQuery<IUser>, trumpCard: TrumpCard) => {
    const [user, errUser] = await getUserMeta({ username: trumpUser.username });
    if (errUser) throw errUser;

    const [cards, err] = await getTrumpCards(trumpUser);
    if (err) throw err;

    if (!trumpCardsAsArray.find((card) => card.handler === trumpCard.handler))
      throw insertErrorStack(ERR_INVALID_TRUMP_CARD);

    if (!cards.find((card) => card.handler === trumpCard.handler))
      throw insertErrorStack(ERR_NO_TRUMP_FOUND);

    const [game, errGame] = await GameController.getGame({
      players: user._id,
    });

    if (errGame) throw errGame;
    if (!game) throw insertErrorStack(ERR_INVALID_GAME);

    // Deny usage of trump card if the user has a status
    if (user.trumpStatus.includes("DENY_TRUMP_USE"))
      throw insertErrorStack(ERR_TRUMP_USE_DENIED);

    // Check for opponent invincibility
    const [opponent, errOpponent] = await GameController.getOpponent(
      game.gameId,
      user.username
    );

    if (errOpponent) throw errOpponent;

    if (
      trumpCard.type === "ATTACK" &&
      opponent?.trumpStatus.includes("INVINCIBLE")
    )
      throw insertErrorStack(ERR_TRUMP_USE_DENIED);

    const [updated, errUpdated] = await removeTrumpCards(
      { username: user.username },
      [trumpCard]
    );
    if (errUpdated) throw errUpdated;

    await trumpCard.onUse(
      {
        username: user.username,
      },
      game
    );

    return updated;
  }
);

const checkForTrumpStatus = asyncTransaction(
  async (target: FilterQuery<IUser>, status: IUser["trumpStatus"]) => {
    const [user, err] = await getUserMeta(target);
    if (err) throw err;

    return user.trumpStatus.find((st) =>
      status.find((status) => status === st)
    );
  }
);

export const UserController = {
  /**
   * @description Get all users' connections
   */
  getAllConnections,
  /**
   * @description Clear stale connection
   */
  clearStaleConnection,
  /**
   * @access Public
   *
   * @description Create a new user
   */
  createUser,
  /**
   * @access System level
   */
  updateUser,
  /**
   * @access System level
   */
  deleteUser,
  /**
   * @access System Level, User themselves, Authorized users
   */
  getUserMeta,
  /**
   * @access System level
   */
  getConnectionId,
  /**
   * @access System level, User themselves
   *
   * Use bypassBlind argument to ignore the blind check,
   * use this function when you're trying to get the blind user card in the blind person perspective
   *
   * @description Get all of the target user cards (the first one should be hidden from opponenet)
   */
  getCards,
  /**
   * @access System level
   */
  setCards,
  /**
   * @access System level
   *
   * @description Add cards to the user, returns ALL the cards
   */
  addCards,
  /**
   * @access System level
   *
   * @description Remove cards from the user, returns ALL the cards
   */
  removeCards,
  /**
   * @access User themselves
   *
   * @description Set the player ready state
   */
  setReadyState,
  /**
   * @access System Level
   *
   * @description Set the player stand state
   */
  setStandState,
  /**
   * @access System Level
   *
   * @description Get the sum of the cards
   */
  getCardsSums,
  /**
   * @access System Level
   *
   * @description Reset players'
   * 1. Stand state
   * 2. Ready state
   * 3. Game score
   * 4. Cards
   * 5. Trump cards
   * 6. Trump Status
   *
   */
  resetPlayersState,
  /**
   * @access System Level
   *
   * @description add the trump cards
   */
  addTrumpCards,
  /**
   * @access System Level
   *
   * @description remove the trump cards
   */
  removeTrumpCards,
  /**
   * @access System Level
   *
   * @description get the trump cards
   */
  getTrumpCards,
  /**
   * @access System Level
   *
   * @description add the trump status
   */
  addTrumpStatus,
  /**
   * @access System Level
   *
   * @description remove the trump status
   */
  removeTrumpStatus,
  /**
   * @access System Level
   *
   * @description check if the user is invincible
   */
  checkInvincibility,
  /**
   * @access System Level
   *
   * @description use the trump card
   */
  useTrumpCard,
  /**
   * @access System Level
   *
   * @description set the trump cards
   */
  setTrumpCards,
  /**
   * @access System Level
   *
   * @description set the trump status
   */
  setTrumpStatus,
  /**
   * @access System Level
   *
   * @description check for trump status
   */
  checkForTrumpStatus,
};
