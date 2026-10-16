// Every trade the AI Trader and Bulk Trades place is mirrored into the run panel on the right (Summary, Transactions and
// the totals under them). That panel was built for the bot builder's contract objects and only counts a contract once it
// looks "ended" (a status other than "open"), and groups updates of one contract by its buy transaction id. Contracts from
// the trading connection do not always carry those fields, so they are filled in here, in one place, for every feed.
type TContract = Record<string, unknown>;

export const forRunPanel = (contract: TContract): TContract => {
    const id = contract.id ?? contract.contract_id;
    const profit = Number(contract.profit ?? 0);
    const status = typeof contract.status === 'string' && contract.status ? contract.status : '';
    const sold = !!contract.is_sold || (status !== '' && status !== 'open');
    const buy_id = (contract.transaction_ids as { buy?: unknown } | undefined)?.buy ?? contract.transaction_id ?? contract.contract_id ?? id;
    return {
        ...contract,
        id,
        contract_id: contract.contract_id ?? id,
        transaction_ids: { ...((contract.transaction_ids as object) || {}), buy: buy_id },
        is_sold: sold ? 1 : contract.is_sold,
        status: status || (sold ? (profit > 0 ? 'won' : 'lost') : 'open'),
        payout: contract.payout ?? contract.sell_price,
    };
};
